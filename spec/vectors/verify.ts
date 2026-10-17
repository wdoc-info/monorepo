// Run from any directory with: bun /absolute/path/to/spec/vectors/verify.ts
// Uses existing app/backend dependencies and never contacts a signing service.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, readDocumentArchive, validateArchive } from '../../backend.wdoc.info/src/signatures/archive';
import { assertKeyRegistry, assertManifest, commitment, documentDigest, encoder, inventory, jcs, parseJson, safePath, verifyDocument, type Files, type Manifest } from '../../backend.wdoc.info/src/signatures/core';
import { assertPayload } from '../../backend.wdoc.info/src/signatures/validation';
import { KeyResolverService } from '../../backend.wdoc.info/src/signatures/services';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const backendRequire = createRequire(resolve(root, 'backend.wdoc.info/package.json'));
const appRequire = createRequire(resolve(root, 'app.wdoc.info/package.json'));
const JSZip = backendRequire('jszip');
const Ajv = appRequire('ajv');
const addFormats = appRequire('ajv-formats');
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
const schemaBase = 'https://www.wdoc.info/schemas/';
const json = async (name: string) => parseJson(await readFile(resolve(here, name), 'utf8'));
const bytes = (files: Record<string, string>): Files => Object.fromEntries(Object.entries(files).map(([p, b]) => [p, new Uint8Array(Buffer.from(b, 'base64'))]));
const decode = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);
const hash = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('base64url');
const summary = (r: any) => ({ documentDigest: r.documentDigest, content: r.content.status, document: r.document.map((c: any) => c.status), forms: r.forms.map((c: any) => c.status), revisions: r.revisions.map((c: any) => c.status), seals: r.seals.map((c: any) => c.status) });
let assertions = 0;
function equal(actual: unknown, expected: unknown, label: string) { assert.deepEqual(actual, expected, label); assertions++; }
function equalInventory(actual: Record<string, string>, expected: Record<string, string>, label: string) {
  equal({ ...actual }, { ...expected }, label);
}
function schema(name: string, value: unknown) {
  const validate = ajv.getSchema(schemaBase + name);
  assert.ok(validate, `Missing schema ${name}`);
  assert.ok(validate(value), `${name}: ${JSON.stringify(validate.errors)}`);
  assertions++;
}
const schemaNames = (await readdir(resolve(here, '../schemas'))).filter(n => n.endsWith('.schema.json')).sort();
for (const name of schemaNames) ajv.addSchema(parseJson(await readFile(resolve(here, '../schemas', name), 'utf8')));
for (const name of schemaNames) assert.ok(ajv.getSchema(schemaBase + name), `Cannot compile ${name}`);
const registry = await json('registry.json');
schema('key-registry.schema.json', registry);
new KeyResolverService(registry.keys, registry.allowedOrigins);
const positive = (await json('positive.json')).cases;
const intermediate = await json('intermediates.json');
const mutations = await json('mutations.json');

const expectedInventory = { 'index.html': hash('html'), 'wdoc-assets/style.css': hash('css') };
const nullPrototypeInventory = Object.assign(Object.create(null), {
  'wdoc-assets/style.css': expectedInventory['wdoc-assets/style.css'], 'index.html': expectedInventory['index.html'],
});
equalInventory(nullPrototypeInventory, expectedInventory, 'Inventory comparison ignores prototypes and member order');
for (const [label, changed] of Object.entries({
  'Modified inventory hash': { ...expectedInventory, 'index.html': hash('changed') },
  'Missing inventory path': { 'index.html': expectedInventory['index.html'] },
  'Additional inventory path': { ...expectedInventory, 'wdoc-assets/extra.css': hash('extra') },
})) {
  assert.throws(() => equalInventory(nullPrototypeInventory, changed, label), { name: 'AssertionError' }, label);
  assertions++;
}

for (const p of intermediate.primitives) {
  equal(createHash('sha256').update(p.utf8).digest('hex'), p.sha256Hex, p.id);
  equal(hash(p.utf8), p.hash, p.id);
}
for (const c of intermediate.canonicalization) equal(jcs(c.input), c.canonical, c.id);
equal(jcs(intermediate.scope.value), intermediate.scope.canonical, 'Canonical protected scope');
equal(hash(intermediate.scope.canonical), intermediate.scope.documentDigest, 'Independent scope hash');
equal(await documentDigest(intermediate.scope.value), intermediate.scope.documentDigest, 'Core scope digest');
for (const c of intermediate.commitments) {
  equal(jcs({ domain: `wdoc-${c.kind}-commitment-v1`, nonce: c.nonce, value: c.value }), c.canonicalPreimage, `${c.kind} preimage`);
  equal(hash(c.canonicalPreimage), c.commitment, `${c.kind} independent hash`);
  equal(await commitment(c.kind, c.value, c.nonce), c.commitment, `${c.kind} core commitment`);
}

function verifyJwsStructureAndMath(jws: string, kind: string, signatureId: string) {
  const parts = jws.split('.');
  equal(parts.length, 3, `${signatureId} compact segments`);
  const header = parseJson(decode(Buffer.from(parts[0], 'base64url')));
  const payloadText = decode(Buffer.from(parts[1], 'base64url'));
  const payload = parseJson(payloadText);
  schema('protected-header.schema.json', header);
  schema(`${kind}-jws.schema.json`, payload);
  equal(header.typ, `wdoc-${kind}+jws`, `${signatureId} context`);
  equal(payloadText, jcs(payload), `${signatureId} canonical producer payload`);
  const record = registry.keys.find((k: any) => k.kid === header.kid);
  assert.ok(record, `No test key for ${header.kid}`);
  const key = createPublicKey({ key: record.jwk, format: 'jwk' });
  assert.ok(verifySignature('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), `${signatureId} independent ES256 verification`);
  assertions++;
  return payload;
}
for (const c of positive) {
  const files = bytes(c.files);
  const manifest = parseJson(decode(files['manifest.json'])) as Manifest;
  schema('manifest.schema.json', manifest);
  equalInventory(await inventory(Object.fromEntries(Object.keys(manifest.content.files).map(p => [p, files[p]]))), manifest.content.files, `${c.id} original inventory`);
  for (const s of [...manifest.signatures.document, ...manifest.runtime.revisions.flatMap(r => r.signatures)]) {
    const payload = verifyJwsStructureAndMath(s.jws, 'document', s.signatureId);
    if (payload.proofMode === 'digest-only') assert.ok(s.nonce, `${c.id} document opening`);
  }
  for (const s of manifest.signatures.forms) {
    const payload = verifyJwsStructureAndMath(s.jws, 'form', s.signatureId);
    if (payload.proofMode === 'digest-only') assert.ok(s.nonce, `${c.id} form opening`);
  }
  for (const path of Object.keys(files).filter(p => p.startsWith('seals/') && p.endsWith('.jws'))) {
    const payload = verifyJwsStructureAndMath(decode(files[path]), 'seal', path);
    if (payload.proofMode === 'digest-only') assert.ok(files[path.replace(/\.jws$/, '.nonce')], `${c.id} seal opening`);
  }
  for (const submissions of Object.values(manifest.runtime.submissions)) for (const s of submissions) schema('answers-html.schema.json', parseJson(decode(files[s.answersFile])));
  equal(summary(await verifyDocument(manifest, files, registry.keys)), c.expected, c.id);
  for (const compression of ['STORE', 'DEFLATE']) for (const prefix of ['', 'Envelope/']) {
    const zip = new JSZip();
    for (const [p, b] of Object.entries(files)) zip.file(prefix + p, b, { createFolders: false });
    const buffer = await zip.generateAsync({ type: 'arraybuffer', compression });
    validateArchive(buffer);
    const { files: roundTrip, rootPrefix } = await readDocumentArchive(buffer);
    equal(rootPrefix, prefix, `${c.id} logical root`);
    equal(Object.keys(roundTrip).sort(), Object.keys(files).sort(), `${c.id} ${compression} ${prefix} membership`);
    for (const path of Object.keys(files)) equal(roundTrip[path], files[path], `${c.id} ${compression} ${prefix} ${path} bytes`);
    equal(summary(await verifyDocument(parseJson(decode(roundTrip['manifest.json'])), roundTrip, registry.keys)), c.expected, `${c.id} ${compression} ${prefix} verification`);
  }
}
const layouts = (await json('layouts.json')).cases;
for (const c of layouts) for (const compression of ['STORE', 'DEFLATE']) {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(c.entries)) zip.file(path, encoder.encode(text as string), {dir:path.endsWith('/'),createFolders:false});
  const buffer = await zip.generateAsync({type:'arraybuffer',compression});
  if (!c.valid) { await assert.rejects(() => readDocumentArchive(buffer), undefined, c.id); assertions++; continue; }
  const result = await readDocumentArchive(buffer);
  equal(result.rootPrefix, c.rootPrefix, `${c.id} root`);
  equal(Object.keys(result.files).sort(), c.logicalFiles, `${c.id} logical membership`);
  for (const [path, value] of Object.entries(result.files)) equal(decode(value), c.entries[c.rootPrefix + path], `${c.id} exact file bytes`);
  equal(Object.hasOwn(result.files, 'manifest.json'), false, `${c.id} no manifest is required`);
}
const formed = positive.find((c: any) => c.id === 'form-signed');
const sealed = positive.find((c: any) => c.id === 'sealed');
const formedFiles = bytes(formed.files);
const formedManifest = parseJson(decode(formedFiles['manifest.json']));
const snapshot = formedManifest.runtime.submissions.approval[0];
const formInventory = await inventory(Object.fromEntries([snapshot.answersFile, ...snapshot.attachments].map(p => [p, formedFiles[p]])));
equalInventory(formInventory, intermediate.commitments.find((c: any) => c.kind === 'form').value.files, 'Published form inventory');
equalInventory(await inventory(formedFiles), intermediate.commitments.find((c: any) => c.kind === 'seal').value.files, 'Seal inventory includes actual manifest bytes');
for (const [kind, payload] of Object.entries(intermediate.payloads)) {
  schema(`${kind}-jws.schema.json`, payload);
  const files = bytes(sealed.files);
  const manifest = parseJson(decode(files['manifest.json']));
  const jws = kind === 'document' ? manifest.signatures.document[0].jws : kind === 'form' ? manifest.signatures.forms[0].jws : decode(files[Object.keys(files).find(p => p.startsWith('seals/') && p.endsWith('.jws'))!]);
  equal(parseJson(decode(Buffer.from(jws.split('.')[1], 'base64url'))), payload, `${kind} published decoded payload`);
}

function pointerSet(target: any, pointer: string, value: unknown, remove = false) {
  const parts = pointer.split('/').slice(1).map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  assert.ok(parts.length, 'Mutation must select a member');
  let parent = target;
  for (const part of parts.slice(0, -1)) { assert.ok(Object.hasOwn(parent, part), `Missing mutation parent ${part}`); parent = parent[part]; }
  const last = parts.at(-1)!;
  if (remove) delete parent[last]; else parent[last] = structuredClone(value);
}
for (const c of mutations.cases) {
  const base = positive.find((p: any) => p.id === c.base);
  assert.ok(base, `Missing base ${c.base}`);
  const files = bytes(base.files);
  const manifest = parseJson(decode(files['manifest.json']));
  const policy = structuredClone(registry);
  let manifestChanged = false, pretty = false;
  for (const op of c.operations) {
    if (op.op === 'file-set') files[op.path] = op.base64 !== undefined ? new Uint8Array(Buffer.from(op.base64, 'base64')) : encoder.encode(op.text);
    else if (op.op === 'file-delete') delete files[op.path];
    else if (op.op === 'manifest-set' || op.op === 'manifest-delete') { pointerSet(manifest, op.pointer, op.value, op.op === 'manifest-delete'); manifestChanged = true; }
    else if (op.op === 'registry-set') pointerSet(policy, op.pointer, op.value);
    else if (op.op === 'manifest-format') { assert.equal(op.style, 'pretty'); pretty = true; manifestChanged = true; }
    else assert.fail(`Unknown mutation ${op.op}`);
  }
  if (manifestChanged) files['manifest.json'] = encoder.encode(pretty ? JSON.stringify(manifest, null, 2) + '\n' : jcs(manifest));
  new KeyResolverService(policy.keys, policy.allowedOrigins);
  if (c.expected.error) { await assert.rejects(() => verifyDocument(manifest, files, policy.keys), undefined, c.id); assertions++; }
  else {
    const actual: any = summary(await verifyDocument(manifest, files, policy.keys));
    for (const [key, value] of Object.entries(c.expected)) equal(actual[key], value, `${c.id} ${key}`);
  }
}
for (const c of mutations.json) {
  let valid = true;
  try { parseJson(c.text); } catch { valid = false; }
  equal(valid, c.valid, c.id);
}
for (const c of mutations.paths) equal(safePath(c.path), c.valid, c.id);

function centralOffsets(buffer: ArrayBuffer): number[] {
  const d = new DataView(buffer), end = buffer.byteLength - 22;
  assert.equal(d.getUint32(end, true), 0x06054b50);
  let offset = d.getUint32(end + 16, true);
  return Array.from({ length: d.getUint16(end + 10, true) }, () => {
    const current = offset;
    offset += 46 + d.getUint16(offset + 28, true) + d.getUint16(offset + 30, true) + d.getUint16(offset + 32, true);
    return current;
  });
}
for (const c of mutations.zip) {
  const zip = new JSZip();
  zip.file(c.operation === 'unsafe-name' ? c.name : ['zip64-extra', 'unicode-override'].includes(c.operation) ? 'café.txt' : 'index.html', 'Test');
  if (c.operation === 'duplicate') zip.file('other.html', 'Other');
  let buffer: ArrayBuffer = await zip.generateAsync({ type: 'arraybuffer', compression: ['valid-deflate', 'valid-streamed', 'underreported-size'].includes(c.operation) ? 'DEFLATE' : 'STORE', streamFiles: c.operation === 'valid-streamed' });
  const offsets = centralOffsets(buffer), d = new DataView(buffer), p = offsets[0];
  if (c.operation === 'duplicate') new Uint8Array(buffer, offsets[1] + 46, 10).set(encoder.encode('index.html'));
  else if (c.operation === 'encrypted') d.setUint16(p + 8, d.getUint16(p + 8, true) | 1, true);
  else if (c.operation === 'large-size') d.setUint32(p + 24, 10_000_001, true);
  else if (c.operation === 'local-name') d.setUint8(30, 0x78);
  else if (c.operation === 'method') { d.setUint16(8, 99, true); d.setUint16(p + 10, 99, true); }
  else if (c.operation === 'crc') d.setUint8(30 + d.getUint16(26, true) + d.getUint16(28, true), 0x78);
  else if (c.operation === 'underreported-size') { d.setUint32(22, 1, true); d.setUint32(p + 24, 1, true); }
  else if (c.operation === 'truncated') buffer = buffer.slice(0, -1);
  else if (c.operation === 'trailing') { const extended = new Uint8Array(buffer.byteLength + 1); extended.set(new Uint8Array(buffer)); buffer = extended.buffer; }
  else if (c.operation === 'zip64-extra' || c.operation === 'unicode-override') {
    const extra = p + 46 + d.getUint16(p + 28, true);
    assert.equal(d.getUint16(extra, true), 0x7075, 'Fixture must have a Unicode-path extra field');
    if (c.operation === 'zip64-extra') d.setUint16(extra, 1, true);
    else d.setUint8(extra + 9, 0x78);
  }
  let valid = true;
  try { await readArchive(buffer); } catch { valid = false; }
  equal(valid, c.valid, c.id);
}
for (const c of mutations.registries) {
  let valid = true;
  try { new KeyResolverService(c.keys, c.allowedOrigins); } catch { valid = false; }
  equal(valid, c.valid, c.id);
}
for (const c of (await json('requests.json')).cases) {
  const index = ['document', 'form', 'seal'].indexOf(c.endpoint.split('/').at(-1));
  assert.ok(index >= 0, c.id);
  const validate = ajv.compile({ $ref: `${schemaBase}attestation-request.schema.json#/oneOf/${index}` });
  equal(validate(c.body), c.valid, `Request ${c.id}`);
}
for (const c of positive) {
  const manifest = parseJson(decode(bytes(c.files)['manifest.json']));
  for (const s of manifest.signatures.document) schema('receipt.schema.json', { signatureId: s.signatureId, jws: s.jws });
}
// Targeted structural rejections supplement mutation cases, which exercise runtime behavior.
const invalidManifests = [
  { ...formedManifest, unexpected: true },
  { ...formedManifest, content: { ...formedManifest.content, files: { ...formedManifest.content.files, 'wdoc-form/bad.txt': intermediate.primitives[0].hash } } },
  { ...formedManifest, signatures: { ...formedManifest.signatures, forms: [{ ...formedManifest.signatures.forms[0], unexpected: true }] } },
];
for (const m of invalidManifests) {
  equal(ajv.getSchema(schemaBase + 'manifest.schema.json')(m), false, 'Closed manifest structure/path rejection');
  await assert.rejects(() => verifyDocument(m, formedFiles, registry.keys)); assertions++;
}
for (const file of ['core.ts', 'archive.ts', 'validation.ts']) {
  const reference = await readFile(resolve(root, 'app.wdoc.info/src/app/signatures', file), 'utf8');
  equal(reference, await readFile(resolve(root, 'backend.wdoc.info/src/signatures', file), 'utf8'), `${file} backend mirror parity`);
  equal(reference, await readFile(resolve(root, 'validator.wdoc.info/src/app/format', file), 'utf8'), `${file} web-validator mirror parity`);
}
for (const name of schemaNames) equal(await readFile(resolve(here, '../schemas', name), 'utf8'), await readFile(resolve(root, 'validator.wdoc.info/src/app/format/schemas', name), 'utf8'), `${name} web-validator schema parity`);
for (const name of ['wdoc-format.md', 'attestation-protocol.md']) equal(await readFile(resolve(here, '..', name), 'utf8'), await readFile(resolve(root, 'validator.wdoc.info/public/spec', name), 'utf8'), `${name} published specification parity`);

// Runtime validators add semantic constraints, but must never accept a structure
// rejected by the independently evaluated normative schemas.
const substitutions = [null, true, false, 0, 1, '', 'text', 'A'.repeat(43), 'A'.repeat(43) + '\n', [], {}, ['verify'], { unexpected: true }];
let substitutionCases = 0;
function memberPaths(value: any, prefix: string[] = []): string[][] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).flatMap(key => [[...prefix, key], ...memberPaths(value[key], [...prefix, key])]);
}
function compareStructure(base: any, runtime: (value: any) => void, schemaName: string) {
  const validate = ajv.getSchema(schemaBase + schemaName);
  for (const path of memberPaths(base)) for (const replacement of substitutions) {
    const changed = structuredClone(base); let parent = changed;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)!] = structuredClone(replacement);
    let accepted = true;
    try { runtime(changed); } catch { accepted = false; }
    assert.ok(!accepted || validate(changed), `${schemaName} runtime accepted a schema-invalid value at ${path.join('/')}: ${JSON.stringify(validate.errors)}`);
    assertions++; substitutionCases++;
  }
}
const revised = positive.find((c: any) => c.id === 'revised');
compareStructure(parseJson(decode(bytes(revised.files)['manifest.json'])), assertManifest, 'manifest.schema.json');
compareStructure(parseJson(decode(bytes(positive.find((c: any) => c.id === 'editable-draft').files)['manifest.json'])), assertManifest, 'manifest.schema.json');
compareStructure(registry, v => assertKeyRegistry(v.keys, v.allowedOrigins), 'key-registry.schema.json');
for (const kind of ['document', 'form', 'seal'] as const) compareStructure(intermediate.payloads[kind], v => assertPayload(v, kind), `${kind}-jws.schema.json`);

async function checkLinks(folder: string) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) await checkLinks(path);
    else if (entry.name.endsWith('.md')) {
      const markdown = await readFile(path, 'utf8');
      for (const match of markdown.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
        const href = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        const [relative, fragment] = href.split('#');
        const target = relative ? resolve(dirname(path), decodeURIComponent(relative)) : path;
        const contents = await readFile(target, 'utf8');
        if (fragment && target.endsWith('.md')) {
          const anchors = [...contents.matchAll(/^#{1,6} (.+)$/gm)].map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-'));
          assert.ok(anchors.includes(decodeURIComponent(fragment)), `Broken anchor ${href} in ${path}`);
        }
        assertions++;
      }
    }
  }
}
await checkLinks(resolve(here, '..'));
console.log(`Specification validation passed: ${schemaNames.length} schemas, ${positive.length} positive archives, ${mutations.cases.length} mutations, ${mutations.json.length} JSON cases, ${mutations.paths.length} paths, ${mutations.zip.length} ZIP safety cases, ${layouts.length} layout cases, ${mutations.registries.length} registries, ${substitutionCases} schema/runtime substitutions, and ${assertions} assertions.`);
