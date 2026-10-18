import { beforeAll, describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import JSZip from 'jszip';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase } from '../db';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { signJwt } from '../auth/jwt';
import { KeyResolverService, SignatureService } from '../signatures/services';
import { archiveCommitment, commitment, documentDigest, encoder, inventory, jcs, newNonce, parseJson, scopeOf, sha256, snapshotCommitment, verifyDocument, verifyJws, type Files, type KeyRecord, type Manifest } from '../signatures/core';
import type { SigningConfig } from '../signatures/routes';
let signing: SigningConfig; let keys: KeyRecord[];
const secret = 'test-jwt-secret-for-document-signatures-1234567890';
const sentinel = 'PRIVATE-CONTENT-NEVER-UPLOADED';
beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  keys = [{ kid: 'https://sig.wdoc.info/info/key-1', jwk: await exportJWK(pair.publicKey), status: 'active', trusted: true, authority: 'platform', owner: 'wdoc' }];
  signing = { keys, allowedOrigins: ['https://sig.wdoc.info'], kid: keys[0]!.kid, privateJwk: await exportJWK(pair.privateKey) };
});
async function fixture() {
  const db = initDatabase(':memory:'); const app = createApp({ db, config: { ...loadConfig(), jwtSecret: secret }, signing });
  const token = await signJwt({ sub: 'alice', email: 'alice@example.com' }, secret, 3600); const sent: any[] = [];
  const request = async (path: string, body?: any, auth = token) => {
    if (body) sent.push(body);
    const response = await app.request(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() as any };
  };
  const files: Files = { 'index.html': encoder.encode(`<form id="private-form">${sentinel}</form>`), 'private-title.css': encoder.encode('p {color:black}') };
  const now = new Date().toISOString();
  const manifest: Manifest = { manifestVersion: '0.1', meta: { docId: crypto.randomUUID(), appVersion: '1', docTitle: sentinel, createdAt: now, contentUpdatedAt: now }, content: { hashAlgorithm: 'SHA-256', files: await inventory(files) }, runtime: { submissions: {}, revisions: [], forms: {} }, signatures: { document: [], forms: [] } };
  const signDocument = async () => {
    const nonce = newNonce(); const c = await commitment('document', await documentDigest(manifest), nonce);
    const response = await request('/signatures/document', { requestId: crypto.randomUUID(), consent: true, documentCommitment: c }); expect(response.status).toBe(200);
    const sig = { ...response.data, nonce }; manifest.signatures.document.push(sig); return sig;
  };
  const doc = await signDocument(); return { db, app, token, request, manifest, files, sent, doc, signDocument };
}
async function form(f: Awaited<ReturnType<typeof fixture>>, auth?: string, existing = false) {
  const formId = 'private-form';
  const submission = existing ? f.manifest.runtime.submissions[formId]![0]! : { submissionId: crypto.randomUUID(), answersFile: '', attachments: [] as string[], createdAt: new Date().toISOString(), documentDigest: await documentDigest(f.manifest) };
  if (!existing) {
    submission.answersFile = `submissions/${submission.submissionId}/answers.json`;
    submission.attachments = [`submissions/${submission.submissionId}/attachments/private-attachment.txt`];
    f.files[submission.answersFile] = encoder.encode(jcs({ answer: sentinel })); f.files[submission.attachments[0]!] = encoder.encode(sentinel);
    (f.manifest.runtime.submissions[formId] ??= []).push(submission);
  }
  const nonce = newNonce(); const value = await snapshotCommitment(f.manifest, formId, submission, f.files, nonce);
  const response = await f.request('/signatures/form', { requestId: crypto.randomUUID(), consent: true, documentProof: f.doc.jws, submissionCommitment: value }, auth); expect(response.status).toBe(200);
  f.manifest.signatures.forms.push({ ...response.data, nonce, formId, submissionId: submission.submissionId }); return submission;
}
describe('private commitment signatures', () => {
  test('verifies locally and never sends or persists document content, file names, IDs or local salts', async () => {
    const f = await fixture(); await form(f); const report = await verifyDocument(f.manifest, f.files, keys);
    expect(report.document[0]!.status).toBe('valid-trusted'); expect(report.forms[0]!.status).toBe('valid-trusted');
    const requests = JSON.stringify(f.sent);
    const persisted = JSON.stringify(f.db.db.query('SELECT * FROM signature_receipts').all()) + JSON.stringify(f.db.db.query('SELECT * FROM signature_events').all());
    for (const value of [sentinel, 'private-title.css', 'private-form', 'private-attachment.txt', f.manifest.meta.docId, f.doc.nonce]) { expect(requests).not.toContain(value); expect(persisted).not.toContain(value); }
    const tables = f.db.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const name of ['signed_documents', 'document_operations', 'document_access', 'document_events']) expect(tables).not.toContain(name);
    for (const row of f.db.db.query<{ receipt: string }, []>('SELECT receipt FROM signature_receipts').all()) {
      const payload = parseJson(Buffer.from(JSON.parse(row.receipt).jws.split('.')[1], 'base64url').toString());
      for (const key of ['files', 'answers', 'manifest', 'attachments', 'docTitle', 'formId', 'docId', 'nonce']) expect(payload).not.toHaveProperty(key);
    }
  });
  test('detects original modifications, snapshot edits, missing attachments and tampered salts', async () => {
    const f = await fixture(); const sub = await form(f);
    f.files['private-title.css'] = encoder.encode('changed'); expect((await verifyDocument(f.manifest, f.files, keys)).document[0]!.status).toBe('file-modified'); f.files['private-title.css'] = encoder.encode('p {color:black}');
    const old = f.files[sub.answersFile]!; f.files[sub.answersFile] = encoder.encode('changed'); expect((await verifyDocument(f.manifest, f.files, keys)).forms[0]!.status).toBe('file-modified'); f.files[sub.answersFile] = old;
    delete f.files[sub.attachments[0]!]; expect((await verifyDocument(f.manifest, f.files, keys)).forms[0]!.status).toBe('file-modified'); f.files[sub.attachments[0]!] = encoder.encode(sentinel);
    f.manifest.signatures.forms[0]!.nonce = newNonce(); expect((await verifyDocument(f.manifest, f.files, keys)).forms[0]!.status).toBe('file-modified');
    f.doc.nonce = newNonce(); expect((await verifyDocument(f.manifest, f.files, keys)).document[0]!.status).toBe('wrong-revision');
  });
  test('supports multiple signers and preserves form signatures through local revisions', async () => {
    const f = await fixture(); await form(f); const bob = await signJwt({ sub: 'bob', email: 'bob@example.com' }, secret, 3600); await form(f, bob, true);
    expect(f.manifest.runtime.submissions['private-form']).toHaveLength(1); expect((await verifyDocument(f.manifest, f.files, keys)).forms.map(c => c.status)).toEqual(['valid-trusted', 'valid-trusted']);
    const old = structuredClone(f.manifest); const d = await documentDigest(old); const paths: Record<string, string> = {};
    for (const p of Object.keys(old.content.files)) { paths[p] = `revisions/${d}/files/${p}`; f.files[paths[p]!] = f.files[p]!; }
    f.manifest.runtime.revisions.push({ scope: scopeOf(old), signatures: old.signatures.document, files: paths }); f.manifest.meta.appVersion = '2'; f.manifest.signatures.document = []; await f.signDocument();
    const report = await verifyDocument(f.manifest, f.files, keys); expect(report.document[0]!.status).toBe('valid-trusted'); expect(report.revisions[0]!.status).toBe('valid-trusted'); expect(report.forms[0]!.status).toBe('valid-trusted');
  });
  test('seals the local archive and detects deletion, including nonce sidecars', async () => {
    const f = await fixture(); const sub = await form(f); const nonce = newNonce(); const value = await archiveCommitment(f.manifest, f.files, '', nonce);
    const response = await f.request('/signatures/seal', { requestId: crypto.randomUUID(), consent: true, documentProof: f.doc.jws, archiveCommitment: value }); expect(response.status).toBe(200);
    const path = `seals/${response.data.signatureId}`; f.files[`${path}.jws`] = encoder.encode(response.data.jws); f.files[`${path}.nonce`] = encoder.encode(nonce);
    expect((await verifyDocument(f.manifest, f.files, keys)).seals.map(c => c.status)).toEqual(['valid-trusted']);
    delete f.files[sub.answersFile]; expect((await verifyDocument(f.manifest, f.files, keys)).seals[0]!.status).toBe('archive-changed');
    delete f.files[`${path}.nonce`]; expect((await verifyDocument(f.manifest, f.files, keys)).seals[0]!.status).toBe('archive-changed');
  });
  test('verifies a private archive offline and enforces browser/backend source parity', async () => {
    const f = await fixture(); await form(f); const folder = await mkdtemp(join(tmpdir(), 'wdoc-private-'));
    try {
      const zip = new JSZip(); zip.file('manifest.json', jcs(f.manifest)); for (const [p, bytes] of Object.entries(f.files)) zip.file(p, bytes);
      const archive = join(folder, 'private.wdoc'); const registry = join(folder, 'keys.json'); await writeFile(archive, await zip.generateAsync({ type: 'uint8array' })); await writeFile(registry, JSON.stringify({ keys, allowedOrigins: signing.allowedOrigins }));
      const result = Bun.spawnSync([process.execPath, 'src/signatures/verify.ts', archive, registry]); expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout.toString()).forms[0].status).toBe('valid-trusted');
      const wrapped = new JSZip();
      for (const entry of Object.values(zip.files)) if (!entry.dir) wrapped.file(`Report/${entry.name}`, await entry.async('uint8array'), { createFolders: false });
      await writeFile(archive, await wrapped.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
      const wrappedResult = Bun.spawnSync([process.execPath, 'src/signatures/verify.ts', archive, registry]);
      expect(wrappedResult.exitCode).toBe(0); expect(JSON.parse(wrappedResult.stdout.toString()).forms[0].status).toBe('valid-trusted');
      for (const prefix of ['', 'Report/']) {
        const plain = new JSZip(); plain.file(`${prefix}index.html`, '<p>Unsigned</p>', { createFolders: false });
        await writeFile(archive, await plain.generateAsync({ type: 'uint8array' }));
        const plainResult = Bun.spawnSync([process.execPath, 'src/signatures/verify.ts', archive, registry]);
        expect(plainResult.exitCode).toBe(0);
        const unsigned = JSON.parse(plainResult.stdout.toString());
        expect(unsigned.documentDigest).toBeNull(); expect(unsigned.content.status).toBe('unsigned'); expect(unsigned.document[0].status).toBe('unsigned');
      }
      const ambiguous = new JSZip(); ambiguous.file('one/index.html', '<p>One</p>'); ambiguous.file('two/index.html', '<p>Two</p>');
      await writeFile(archive, await ambiguous.generateAsync({ type: 'uint8array' }));
      const rejected = Bun.spawnSync([process.execPath, 'src/signatures/verify.ts', archive, registry]);
      expect(rejected.exitCode).toBe(1); expect(rejected.stderr.toString()).toContain('exactly one enclosing folder');
      for (const name of ['core.ts', 'archive.ts', 'validation.ts']) expect(await Bun.file(new URL(`../signatures/${name}`, import.meta.url)).text()).toBe(await Bun.file(new URL(`../../../app.wdoc.info/src/app/signatures/${name}`, import.meta.url)).text());
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  test('rejects untrusted keys and algorithms and keeps retired keys verifiable after rotation', async () => {
    const f = await fixture(); expect((await verifyDocument(f.manifest, f.files, [])).document[0]!.status).toBe('key-unavailable'); expect((await verifyDocument(f.manifest, f.files, [{ ...keys[0]!, trusted: false }])).document[0]!.status).toBe('valid-untrusted'); expect((await verifyDocument(f.manifest, f.files, [{ ...keys[0]!, status: 'revoked' }])).document[0]!.status).toBe('key-unauthorized');
    const parts = f.doc.jws.split('.'); parts[0] = Buffer.from(JSON.stringify({ alg: 'none', typ: 'wdoc-document+jws', kid: keys[0]!.kid })).toString('base64url'); expect((await verifyJws(parts.join('.'), 'document', keys)).check.status).toBe('key-unauthorized');
    const pair = await generateKeyPair('ES256', { extractable: true }); const next: KeyRecord = { ...keys[0]!, kid: 'https://sig.wdoc.info/info/key-2', jwk: await exportJWK(pair.publicKey) }; const registry = [{ ...keys[0]!, status: 'retired' as const }, next];
    const rotated = new SignatureService(new KeyResolverService(registry, signing.allowedOrigins), next.kid, await exportJWK(pair.privateKey)); const nonce = newNonce();
    f.manifest.signatures.document.push({ signatureId: crypto.randomUUID(), nonce, jws: await rotated.sign('document', { type: 'wdoc-document-signature', proofMode: 'digest-only', documentCommitment: await commitment('document', await documentDigest(f.manifest), nonce), signedAt: new Date().toISOString(), signer: { userId: 'alice', displayName: 'alice@example.com' }, evidence: { scope: 'commitment-only', method: 'authenticated-session', consent: 'wdoc-sign-v1' } }) }); expect((await verifyDocument(f.manifest, f.files, registry)).document.map(c => c.status)).toEqual(['valid-trusted', 'valid-trusted']);
  });
});
describe('strict digest-only API', () => {
  test('rejects invalid UTF-8 and UUID/commitment line breaks as invalid requests', async () => {
    const f = await fixture();
    const body = { requestId: crypto.randomUUID(), consent: true, documentCommitment: newNonce() };
    expect((await f.request('/signatures/document', {...body, requestId: body.requestId + '\n'})).status).toBe(400);
    expect((await f.request('/signatures/document', {...body, documentCommitment: body.documentCommitment + '\n'})).status).toBe(400);
    const bytes = encoder.encode(JSON.stringify({requestId:crypto.randomUUID(),consent:true,documentProof:'ASCII',submissionCommitment:newNonce()}));
    bytes[Buffer.from(bytes).indexOf('ASCII')] = 0xc3;
    const response = await f.app.request('/signatures/form', {method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:bytes});
    expect(response.status).toBe(400); expect((await response.json() as any).error.code).toBe('INVALID_REQUEST');
  });
  test('requires authentication, consent and a valid original attestation', async () => {
    const f = await fixture(); const body = { requestId: crypto.randomUUID(), consent: true, documentCommitment: newNonce() };
    expect((await f.request('/signatures/document', body, '')).status).toBe(401); expect((await f.request('/signatures/document', { ...body, consent: false })).status).toBe(400);
    expect((await f.request('/signatures/form', { requestId: crypto.randomUUID(), consent: true, documentProof: 'forged', submissionCommitment: newNonce() })).status).toBe(403);
    expect((await f.request('/info/key-1', undefined, '')).data.d).toBeUndefined(); expect((await f.request('/signing-keys', undefined, '')).data.keys[0].jwk.d).toBeUndefined();
  });
  test('rejects document uploads, every content field and oversized requests', async () => {
    const f = await fixture(); const body = { requestId: crypto.randomUUID(), consent: true, documentCommitment: newNonce() };
    for (const field of ['files', 'manifest', 'answers', 'attachments', 'docId', 'title', 'nonce']) expect((await f.request('/signatures/document', { ...body, [field]: sentinel })).status).toBe(400);
    for (const suffix of ['', '/verify', '/signatures']) expect((await f.app.request(`/documents/id${suffix}`)).status).toBe(404);
    expect((await f.app.request('/documents/id', { method: 'POST', body: JSON.stringify({ files: sentinel }) })).status).toBe(404); expect((await f.request('/signatures/document', { ...body, files: 'x'.repeat(17000) })).status).toBe(413);
    expect(f.db.db.query<{ count: number }, []>('SELECT count(*) AS count FROM signature_receipts').get()!.count).toBe(1);
  });
  test('deduplicates concurrent retries and persists an append-only hash journal', async () => {
    const f = await fixture(); const body = { requestId: crypto.randomUUID(), consent: true, documentCommitment: newNonce() };
    const responses = await Promise.all([f.request('/signatures/document', body), f.request('/signatures/document', body)]); expect(responses.map(r => r.status)).toEqual([200, 200]); expect(responses[0]!.data).toEqual(responses[1]!.data);
    expect((await f.request('/signatures/document', { ...body, documentCommitment: newNonce() })).status).toBe(409);
    const events = f.db.db.query<{ event: string; hash: string }, []>('SELECT event, hash FROM signature_events ORDER BY sequence').all(); expect(events).toHaveLength(2); expect(JSON.parse(events[1]!.event).previousHash).toBe(events[0]!.hash); expect(events[1]!.hash).toBe(await sha256(encoder.encode(jcs(JSON.parse(events[1]!.event)))));
    expect(() => f.db.db.exec('DELETE FROM signature_events')).toThrow('append-only'); expect(() => f.db.db.exec("UPDATE signature_events SET event='{}'")).toThrow('append-only');
  });
  test('does not record a signature if the server key is unavailable', async () => {
    const f = await fixture(); const db = initDatabase(':memory:'); const app = createApp({ db, config: { ...loadConfig(), jwtSecret: secret }, signing: { keys, allowedOrigins: signing.allowedOrigins } });
    const response = await app.request('/signatures/document', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.token}` }, body: JSON.stringify({ requestId: crypto.randomUUID(), consent: true, documentCommitment: newNonce() }) }); expect(response.status).toBe(503); expect(db.db.query<{ count: number }, []>('SELECT count(*) AS count FROM signature_receipts').get()!.count).toBe(0);
  });
});
