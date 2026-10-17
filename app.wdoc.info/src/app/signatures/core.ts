// Kept byte-identical to the frontend verification core; parity is tested in Bun.
import canonicalize from 'canonicalize';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { compactVerify, importJWK, type JWK } from 'jose';
import { assertKeyRegistry, assertManifestStructure, assertPayload, COMMITMENT_PATTERN, isDigest, isIdentifier, isRecord, requireValid, runtimePath, safePath, validKid } from './validation';
export { assertKeyRegistry, assertDraftSection, isDateTime, isDigest, isIdentifier, isRecord, COMMITMENT_PATTERN, runtimePath, safePath } from './validation';

export type Files = Record<string, Uint8Array>;
export interface Scope {
  manifestVersion: '1.0';
  meta: { docId: string; appVersion: string; createdAt: string; contentUpdatedAt: string; docTitle?: string; creator?: string; docVersion?: string; [key: string]: unknown };
  content: { hashAlgorithm: 'SHA-256'; files: Record<string, string>; [key: string]: unknown };
}
export interface Submission {
  submissionId: string; answersFile: string; attachments: string[]; createdAt: string;
  documentDigest: string; replaces?: string;
}
export interface Signature { signatureId: string; jws: string; nonce: string; formId?: string; submissionId?: string }
export interface Revision { scope: Scope; files: Record<string, string>; signatures: Signature[] }
export interface Manifest extends Scope {
  runtime: { updatedAt?: string; forms?: Record<string, unknown>; submissions: Record<string, Submission[]>; revisions: Revision[]; [key: string]: unknown };
  signatures: { document: Signature[]; forms: Signature[] };
}
export interface KeyRecord {
  kid: string; jwk: JWK; status: 'active' | 'retired' | 'revoked'; trusted: boolean;
  authority: 'platform' | 'personal'; owner: string; userId?: string; notBefore?: string; expiresAt?: string;
}
export type Status = 'valid-trusted' | 'valid-untrusted' | 'file-modified' | 'invalid-signature' | 'key-unavailable' | 'key-unauthorized' | 'wrong-revision' | 'unsigned' | 'archive-changed';
export interface Check {
  signatureId?: string; formId?: string; submissionId?: string; status: Status;
  kid?: string; owner?: string; authority?: string; signer?: unknown; signedAt?: string; detail?: string; proofMode?: 'digest-only';
}
export interface Verification { documentDigest: string; content: Check; document: Check[]; forms: Check[]; seals: Check[]; revisions: Check[] }
export const encoder = new TextEncoder();
export function jcs(value: unknown): string {
  // canonicalize uses ECMAScript number/string serialization and UTF-16 key order.
  // Reject lone surrogates, undefined and non-JSON objects before canonicalization.
  const ancestors = new Set<object>();
  const validate = (v: unknown, depth = 0): void => {
    if (typeof v === 'string') {
      for (let i = 0; i < v.length; i++) {
        const n = v.charCodeAt(i);
        if (n >= 0xd800 && n <= 0xdbff) { const next = v.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode'); }
        else if (n >= 0xdc00 && n <= 0xdfff) throw new Error('Invalid Unicode');
      }
    } else if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('Invalid number'); }
    else if (v !== null && typeof v === 'object') {
      if (depth >= 64 || ancestors.has(v)) throw new Error('Invalid JSON nesting');
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Not JSON');
      if (Object.getOwnPropertySymbols(v).length || (Array.isArray(v) && (Object.keys(v).length !== v.length || Array.from({length:v.length}, (_, i) => Object.hasOwn(v, i)).includes(false)))) throw new Error('Not JSON');
      ancestors.add(v);
      for (const [k, child] of Object.entries(v)) { validate(k); validate(child, depth + 1); }
      ancestors.delete(v);
    } else if (v !== null && typeof v !== 'boolean') throw new Error('Not JSON');
  };
  validate(value);
  return canonicalize(value)!;
}
// Parse JSON without accepting duplicate object keys (including escaped spellings).
export function parseJson(text: string): any {
  const value = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') { stack.push(token === '{' ? new Set() : null); if (stack.length > 64) throw new Error('JSON is too deeply nested'); }
    else if (token === '}' || token === ']') stack.pop();
    else if (tokens[i + 1] === ':' && token?.startsWith('"')) {
      const keys = stack[stack.length - 1]; const key = JSON.parse(token);
      if (keys?.has(key)) throw new Error('Duplicate JSON key'); keys?.add(key);
    }
  }
  jcs(value); return value;
}
export function base64url(bytes: Uint8Array): string {
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}
export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('UTF-8 BOM is not allowed');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error('Noncanonical base64url');
  return bytes;
}
export function assertFiles(files: Files): void {
  requireValid(isRecord(files) && Object.keys(files).length <= 1000, 'Too many archive files');
  let total = 0;
  for (const [path, bytes] of Object.entries(files)) {
    requireValid(safePath(path) && bytes instanceof Uint8Array, 'Invalid archive file');
    total += bytes.length;
    requireValid(bytes.length <= 10_000_000 && total <= 30_000_000, 'Expanded archive exceeds limits');
  }
}
export function scopeOf(manifest: Scope): Scope {
  return { manifestVersion: manifest.manifestVersion, meta: manifest.meta, content: manifest.content };
}
export async function documentDigest(scope: Scope): Promise<string> { return sha256(encoder.encode(jcs(scopeOf(scope)))); }
export async function inventory(files: Files): Promise<Record<string, string>> {
  const hashes: Record<string, string> = Object.create(null);
  for (const path of Object.keys(files).sort()) {
    if (!safePath(path)) throw new Error(`Unsafe path: ${path}`);
    hashes[path] = await sha256(files[path]!);
  }
  return hashes;
}
// Nonces remain in the local archive, never in a signing request.
export function newNonce(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function commitment(kind: 'document' | 'form' | 'seal', value: unknown, nonce: string): Promise<string> {
  if (!COMMITMENT_PATTERN.test(nonce)) throw new Error('Invalid local commitment nonce');
  return sha256(encoder.encode(jcs({ domain: `wdoc-${kind}-commitment-v1`, nonce, value })));
}
export async function snapshotCommitment(manifest: Manifest, formId: string, submission: Submission, files: Files, nonce: string): Promise<string> {
  const snapshot: Files = Object.create(null);
  for (const path of [submission.answersFile, ...submission.attachments]) {
    if (!files[path]) throw new Error('Missing snapshot file');
    snapshot[path] = files[path]!;
  }
  return commitment('form', { docId: manifest.meta.docId, documentDigest: submission.documentDigest, formId, submissionId: submission.submissionId, files: await inventory(snapshot) }, nonce);
}
export async function archiveCommitment(manifest: Manifest, files: Files, sealId: string, nonce: string): Promise<string> {
  const all: Files = { ...files, 'manifest.json': files['manifest.json'] ?? encoder.encode(jcs(manifest)) };
  delete all[`seals/${sealId}.jws`]; delete all[`seals/${sealId}.nonce`];
  return commitment('seal', { docId: manifest.meta.docId, files: await inventory(all) }, nonce);
}
export function assertManifest(m: unknown): asserts m is Manifest {
  jcs(m);
  assertManifestStructure(m);
}
export async function checkFiles(hashes: Record<string, string>, files: Files): Promise<boolean> {
  for (const [path, hash] of Object.entries(hashes)) if (!safePath(path) || !Object.hasOwn(files, path) || await sha256(files[path]!) !== hash) return false;
  return true;
}
export async function verifyJws(jws: string, typ: 'document' | 'form' | 'seal', keys: KeyRecord[]): Promise<{ check: Check; payload?: any }> {
  let kid: string | undefined;
  try {
    const segments = jws.split('.');
    const header = parseJson(decodeUtf8(decodeBase64url(segments[0] ?? '')));
    if (!isRecord(header) || Object.keys(header).some(k => !['alg', 'typ', 'kid'].includes(k)) || header['alg'] !== 'ES256' || header['typ'] !== `wdoc-${typ}+jws` || !validKid(header['kid'])) return { check: { status: 'key-unauthorized' } };
    kid = header['kid'];
    try { jcs(keys); assertKeyRegistry(keys); } catch { return { check: { status: 'key-unauthorized', kid } }; }
    const record = keys.find(k => k.kid === kid);
    if (!record) return { check: { status: 'key-unavailable', kid } };
    if (record.status === 'revoked' || (record.expiresAt && Date.now() >= Date.parse(record.expiresAt)) || (record.notBefore && Date.now() < Date.parse(record.notBefore))) return { check: { status: 'key-unauthorized', kid } };
    if (segments.length !== 3 || decodeBase64url(segments[2] ?? '').length !== 64) throw new Error('Invalid compact JWS');
    decodeBase64url(segments[1] ?? '');
    let key;
    try { key = await importJWK(record.jwk, 'ES256'); } catch { return { check: { status: 'key-unauthorized', kid } }; }
    const { payload } = await compactVerify(jws, key, { algorithms: ['ES256'] });
    const data = parseJson(decodeUtf8(payload));
    assertPayload(data, typ);
    if ((typ !== 'form' && record.authority !== 'platform') || (typ === 'form' && (data.mode !== (record.authority === 'platform' ? 'wdoc-attestation' : 'personal') || (record.authority === 'personal' && data.signer.userId !== record.userId)))) return { check: { status: 'key-unauthorized', kid } };
    return { check: { proofMode: 'digest-only' as const, status: record.trusted ? 'valid-trusted' : 'valid-untrusted', kid, owner: record.owner, authority: record.authority, signedAt: data.signedAt, signer: data.signer }, payload: data };
  } catch { return { check: { status: 'invalid-signature', kid } }; }
}
export function formIds(html: string): string[] {
  const result: string[] = [];
  walkHtml(html, node => { if (node.tagName === 'form') result.push(node.attrs.find(a => a.name === 'id')?.value || `form-${result.length + 1}`); });
  return result;
}
function walkHtml(html: string, visit: (node: DefaultTreeAdapterMap['element']) => void) {
  const walk = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node) visit(node);
    if ('childNodes' in node) for (const child of node.childNodes) walk(child);
    if ('content' in node) walk((node as DefaultTreeAdapterMap['template']).content);
  };
  walk(parse(html));
}
// Signed originals must be self-contained. Runtime files cannot supply rendering resources.
export function dependenciesValid(scope: Scope, files: Files): boolean {
  try {
    const reference = (value: string, path: string) => {
      const ref = value.trim();
      if (!ref || ref.startsWith('#') || /^data:(?:image\/(?:png|jpe?g|gif|webp|avif)|font\/|application\/(?:font|octet-stream))/i.test(ref)) return;
      const url = new URL(ref, `https://archive.invalid/${path}`);
      const resolved = decodeURIComponent(url.pathname.slice(1));
      if (url.origin !== 'https://archive.invalid' || !safePath(resolved) || !Object.hasOwn(scope.content.files, resolved)) throw new Error('Unprotected rendering resource');
    };
    const css = (text: string, path: string) => {
      // This profile rejects CSS escapes and image-set string URLs rather than interpreting ambiguous dependencies.
      const normalized = text.replace(/\\200[bB](?=["'])/g, '\u200b');
      if (normalized.includes('\\') || /image-set\s*\(/i.test(normalized)) throw new Error('Unsupported CSS dependency');
      const clean = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of clean.matchAll(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) reference(match[1] ?? match[2] ?? match[3]!, path);
      for (const match of clean.matchAll(/@import\s+["']([^"']+)["']/gi)) reference(match[1]!, path);
    };
    for (const path of Object.keys(scope.content.files)) {
      if (!files[path]) continue;
      const text = /\.(?:css|html?|svg)$/i.test(path) ? decodeUtf8(files[path]) : '';
      if (/\.css$/i.test(path)) css(text, path);
      if (/\.(?:html?|svg)$/i.test(path)) walkHtml(text, node => {
        if (['base', 'iframe', 'object', 'embed', 'script', 'animate', 'animateMotion', 'animateTransform', 'set', 'foreignObject'].includes(node.tagName)) throw new Error('Active original content is unsupported');
        for (const attr of node.attrs) {
          if (attr.name === 'srcset') throw new Error('srcset must be flattened before signing');
          if (attr.name === 'src' || attr.name === 'poster' || (attr.name === 'href' && node.tagName !== 'a')) reference(attr.value, path);
          if (attr.name === 'style') css(attr.value, path);
        }
        if (node.tagName === 'style') css(node.childNodes.map(n => 'value' in n ? n.value : '').join(''), path);
      });
    }
    return true;
  } catch { return false; }
}
export async function verifyDocument(manifest: Manifest, files: Files, keys: KeyRecord[]): Promise<Verification> {
  assertManifest(manifest);
  assertFiles(files);
  if (files['manifest.json']) requireValid(jcs(parseJson(decodeUtf8(files['manifest.json']))) === jcs(manifest), 'Parsed manifest differs from archive bytes');
  const signatureIds = new Set([...manifest.signatures.document, ...manifest.signatures.forms, ...manifest.runtime.revisions.flatMap(r => r.signatures)].map(s => s.signatureId));
  for (const path of Object.keys(files).filter(p => /^seals\/[^/]+\.jws$/.test(p))) {
    const id = path.slice(6, -4);
    requireValid(isIdentifier(id) && !signatureIds.has(id), 'Invalid or duplicate seal ID');
    signatureIds.add(id);
  }
  const digest = await documentDigest(manifest);
  const originals = Object.keys(files).filter(p => p !== 'manifest.json' && !runtimePath(p));
  const contentOK = Object.keys(files).every(p => safePath(p) && (!p.startsWith('seals/') || ((/^seals\/[\w-]+\.jws$/.test(p) && Object.hasOwn(files, p.replace(/\.jws$/, '.nonce'))) || (/^seals\/[\w-]+\.nonce$/.test(p) && Object.hasOwn(files, p.replace(/\.nonce$/, '.jws')))))) && dependenciesValid(manifest, files) && await checkFiles(manifest.content.files, files) && originals.every(p => Object.hasOwn(manifest.content.files, p));
  const verifyScope = async (scope: Scope, signatures: Signature[], source: Files): Promise<Check[]> => {
    const d = await documentDigest(scope);
    const ok = dependenciesValid(scope, source) && await checkFiles(scope.content.files, source);
    return Promise.all(signatures.map(async s => {
      const { check, payload } = await verifyJws(s.jws, 'document', keys);
      if (payload) {
        if (payload.documentCommitment !== await commitment('document', d, s.nonce)) check.status = 'wrong-revision';
      }
      if (payload && !ok && check.status.startsWith('valid-')) check.status = 'file-modified';
      return { ...check, signatureId: s.signatureId };
    }));
  };
  const document = await verifyScope(manifest, manifest.signatures.document, files);
  if (!contentOK) for (const c of document) if (c.status.startsWith('valid-')) c.status = 'file-modified';
  const revisions: Check[] = [];
  const revisionChecks = new Map<string, Check[]>();
  const signedScopes = new Map<string, { scope: Scope; signatures: Signature[] }>();
  const scopeDigests = new Set([digest]);
  for (const revision of manifest.runtime.revisions) {
    const source: Files = Object.create(null);
    const d = await documentDigest(revision.scope);
    requireValid(!scopeDigests.has(d), 'Duplicate historical scope'); scopeDigests.add(d);
    for (const [original, archived] of Object.entries(revision.files)) {
      if (!safePath(archived) || archived !== `revisions/${d}/files/${original}`) throw new Error('Invalid revision path');
      if (files[archived]) source[original] = files[archived]!;
    }
    const checks = await verifyScope(revision.scope, revision.signatures, source);
    revisionChecks.set(d, checks); signedScopes.set(d, { scope: revision.scope, signatures: revision.signatures }); revisions.push(...checks);
  }
  revisionChecks.set(digest, document); signedScopes.set(digest, { scope: manifest, signatures: manifest.signatures.document });
  const matchesDocumentCommitment = async (d: string, expected: string): Promise<boolean> => {
    const historical = signedScopes.get(d);
    if (!historical) return false;
    const checks = revisionChecks.get(d) ?? [];
    for (const sig of historical.signatures) if (sig.nonce && checks.some(c => c.signatureId === sig.signatureId && c.status === 'valid-trusted') && await commitment('document', d, sig.nonce) === expected) return true;
    return false;
  };
  const forms: Check[] = [];
  for (const signature of manifest.signatures.forms) {
    const { check, payload } = await verifyJws(signature.jws, 'form', keys);
    if (payload) {
      const submission = manifest.runtime.submissions[signature.formId ?? '']?.find(s => s.submissionId === signature.submissionId);
      try {
        if (!submission || !await matchesDocumentCommitment(submission.documentDigest, payload.documentCommitment)) check.status = 'wrong-revision';
        else if (payload.submissionCommitment !== await snapshotCommitment(manifest, signature.formId!, submission, files, signature.nonce)) check.status = 'file-modified';
      } catch { check.status = 'file-modified'; }
    }
    forms.push({ ...check, signatureId: signature.signatureId, formId: signature.formId, submissionId: signature.submissionId });
  }
  for (const [formId, submissions] of Object.entries(manifest.runtime.submissions)) for (const s of submissions) {
    if (!manifest.signatures.forms.some(sig => sig.formId === formId && sig.submissionId === s.submissionId)) forms.push({ formId, submissionId: s.submissionId, status: 'unsigned' });
  }
  const seals: Check[] = [];
  const fullFiles = { ...files, 'manifest.json': files['manifest.json'] ?? encoder.encode(jcs(manifest)) };
  for (const path of Object.keys(files).filter(p => /^seals\/[\w-]+\.jws$/.test(p))) {
    let sealText: string;
    try { sealText = decodeUtf8(files[path]!); } catch { seals.push({signatureId:path,status:'invalid-signature'}); continue; }
    const { check, payload } = await verifyJws(sealText, 'seal', keys);
    if (payload) {
      const sealId = path.slice(6, -4);
      try {
        const nonce = decodeUtf8(files[`seals/${sealId}.nonce`]!);
        let bound = false;
        for (const d of signedScopes.keys()) if (await matchesDocumentCommitment(d, payload.documentCommitment)) bound = true;
        if (!bound) check.status = 'wrong-revision';
        else if (payload.archiveCommitment !== await archiveCommitment(manifest, fullFiles, sealId, nonce)) check.status = 'archive-changed';
      } catch { check.status = 'archive-changed'; }
    }
    seals.push({ ...check, signatureId: path });
  }
  return { documentDigest: digest, content: { status: contentOK ? 'valid-untrusted' : 'file-modified', detail: 'Hashes alone do not authenticate identity.' }, document: document.length ? document : [{ status: 'unsigned' }], forms, seals, revisions };
}
