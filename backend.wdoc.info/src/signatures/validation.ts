// Mirrored in the backend. Structural rules correspond to spec/schemas/.
import type { KeyRecord, Manifest, Scope } from './core';

export const COMMITMENT_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$(?![\s\S])/;
export const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export const isDigest = (value: unknown): value is string => typeof value === 'string' && COMMITMENT_PATTERN.test(value);
export const isIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$(?![\s\S])/.test(value) && safePath(value);
export const isCompactJws = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/.test(value);
export function requireValid(condition: unknown, message = 'Invalid format'): asserts condition { if (!condition) throw new Error(message); }
export function safePath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 512 || /[\\\x00-\x1f\x7f:%?#]/.test(path)) return false;
  // Reject ill-formed Unicode even for callers operating on an in-memory map.
  for (let i = 0; i < path.length; i++) {
    const n = path.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) { const next = path.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (n >= 0xdc00 && n <= 0xdfff) return false;
  }
  return path.split('/').every(s => s !== '' && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(s));
}
export function runtimePath(path: string): boolean { return /^(\.git|wdoc-form|wdoc-font-cache|submissions|seals|revisions)\//.test(path); }
export function externalFontUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\{};"'<>]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.href === value; } catch { return false; }
}
export function fields(value: unknown, required: string[], optional: string[] = [], extensions = false): asserts value is Record<string, any> {
  requireValid(isRecord(value) && required.every(k => Object.hasOwn(value, k)), 'Invalid object structure');
  requireValid(extensions || Object.keys(value).every(k => required.includes(k) || optional.includes(k)), 'Unknown object member');
}
export function isDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$(?![\s\S])/.exec(value);
  if (!m) return false;
  const [y, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const days = [31, y! % 4 === 0 && (y! % 100 !== 0 || y! % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = m[7]!;
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= days[month! - 1]! && hour! <= 23 && minute! <= 59 && second! <= 59 &&
    (zone.length === 1 || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59)) && Number.isFinite(Date.parse(value));
}
function optional(value: Record<string, any>, key: string, predicate: (v: unknown) => boolean) { requireValid(!Object.hasOwn(value, key) || predicate(value[key]), `Invalid ${key}`); }
const nonempty = (v: unknown) => typeof v === 'string' && v.length > 0;
const string = (v: unknown) => typeof v === 'string';
function hashMap(value: unknown, original = false): asserts value is Record<string, string> {
  requireValid(isRecord(value), 'Invalid file inventory');
  for (const [path, hash] of Object.entries(value)) requireValid(safePath(path) && (!original || (path !== 'manifest.json' && !runtimePath(path))) && isDigest(hash), 'Invalid file inventory');
}
export function assertScopeStructure(value: unknown): asserts value is Scope {
  fields(value, ['manifestVersion', 'meta', 'content']);
  requireValid(value['manifestVersion'] === '0.1', 'Unsupported manifest version');
  fields(value['meta'], ['docId', 'appVersion', 'createdAt', 'contentUpdatedAt'], [], true);
  requireValid(isIdentifier(value['meta']['docId']) && nonempty(value['meta']['appVersion']) && isDateTime(value['meta']['createdAt']) && isDateTime(value['meta']['contentUpdatedAt']), 'Invalid metadata');
  for (const key of ['docTitle', 'creator', 'docVersion']) optional(value['meta'], key, string);
  fields(value['content'], ['hashAlgorithm', 'files'], [], true);
  requireValid(value['content']['hashAlgorithm'] === 'SHA-256', 'Unsupported hash algorithm');
  hashMap(value['content']['files'], true);
  if (Object.hasOwn(value['content'], 'externalFonts')) {
    const fonts = value['content']['externalFonts'];
    requireValid(isRecord(fonts) && Object.keys(fonts).length <= 64, 'Invalid external font inventory');
    for (const [url, hash] of Object.entries(fonts)) requireValid(externalFontUrl(url) && isDigest(hash), 'Invalid external font inventory');
  }
  requireValid(Object.hasOwn(value['content']['files'], 'index.html'), 'Missing original index.html');
}
function wrappers(value: unknown, ids: Set<string>, form = false) {
  requireValid(Array.isArray(value), 'Invalid signature array');
  for (const s of value) {
    fields(s, ['signatureId', 'jws', 'nonce', ...(form ? ['formId', 'submissionId'] : [])]);
    requireValid(isIdentifier(s['signatureId']) && !ids.has(s['signatureId']) && isCompactJws(s['jws']), 'Invalid or duplicate signature ID');
    ids.add(s['signatureId']);
    requireValid(isDigest(s['nonce']), 'Invalid commitment nonce');
    if (form) requireValid(isIdentifier(s['formId']) && isIdentifier(s['submissionId']), 'Invalid signature reference');
  }
}
export function assertDraftSection(value: unknown): void {
  fields(value, ['hashAlgorithm', 'files']);
  requireValid(value['hashAlgorithm'] === 'SHA-256', 'Unsupported draft hash algorithm');
  hashMap(value['files']);
  requireValid(Object.keys(value['files']).every(p => p.startsWith('wdoc-form/')), 'Invalid draft inventory path');
}
export function assertManifestStructure(value: unknown): asserts value is Manifest {
  fields(value, ['manifestVersion', 'meta', 'content', 'runtime', 'signatures']);
  assertScopeStructure({ manifestVersion: value['manifestVersion'], meta: value['meta'], content: value['content'] });
  fields(value['runtime'], ['submissions', 'revisions'], ['forms', 'updatedAt'], true);
  optional(value['runtime'], 'updatedAt', isDateTime);
  if (Object.hasOwn(value['runtime'], 'forms')) {
    requireValid(isRecord(value['runtime']['forms']), 'Invalid draft sections');
    for (const s of Object.values(value['runtime']['forms'])) assertDraftSection(s);
  }
  requireValid(isRecord(value['runtime']['submissions']) && Array.isArray(value['runtime']['revisions']), 'Invalid runtime');
  fields(value['signatures'], ['document', 'forms']);
  const ids = new Set<string>();
  wrappers(value['signatures']['document'], ids); wrappers(value['signatures']['forms'], ids, true);
  const submissions = new Set<string>();
  for (const [formId, entries] of Object.entries(value['runtime']['submissions'])) {
    requireValid(isIdentifier(formId) && Array.isArray(entries), 'Invalid form');
    for (const s of entries) {
      fields(s, ['submissionId', 'answersFile', 'attachments', 'createdAt', 'documentDigest'], ['replaces']);
      requireValid(isIdentifier(s['submissionId']) && !submissions.has(s['submissionId']) && isDateTime(s['createdAt']) && isDigest(s['documentDigest']), 'Invalid submission');
      submissions.add(s['submissionId']);
      const prefix = `submissions/${s['submissionId']}/`;
      requireValid(s['answersFile'] === `${prefix}answers.json` && safePath(s['answersFile']), 'Invalid answers path');
      requireValid(Array.isArray(s['attachments']) && new Set(s['attachments']).size === s['attachments'].length && s['attachments'].every((p: unknown) => safePath(p) && p.startsWith(`${prefix}attachments/`) && !p.slice(`${prefix}attachments/`.length).includes('/')), 'Invalid attachment inventory');
      optional(s, 'replaces', isIdentifier);
    }
  }
  for (const r of value['runtime']['revisions']) {
    fields(r, ['scope', 'files', 'signatures']); assertScopeStructure(r['scope']);
    requireValid(r['scope']['meta']['docId'] === value['meta']['docId'] && isRecord(r['files']), 'Invalid historical scope');
    const paths = Object.keys(r['scope']['content']['files']);
    requireValid(Object.keys(r['files']).length === paths.length && paths.every(p => Object.hasOwn(r['files'], p) && safePath(r['files'][p]) && /^revisions\/[A-Za-z0-9_-]{43}\/files\/[\s\S]+$(?![\s\S])/.test(r['files'][p])), 'Incomplete historical file map');
    wrappers(r['signatures'], ids);
  }
}
export function assertPayload(value: unknown, kind: 'document' | 'form' | 'seal'): void {
  fields(value, ['type', 'proofMode', 'documentCommitment', 'signer', 'signedAt', 'evidence', ...(kind === 'form' ? ['mode', 'submissionCommitment'] : kind === 'seal' ? ['archiveCommitment'] : [])]);
  requireValid(value['type'] === `wdoc-${kind}-signature` && isDateTime(value['signedAt']), 'Invalid JWS payload');
  requireValid(value['proofMode'] === 'digest-only' && isDigest(value['documentCommitment']) && (kind !== 'form' || isDigest(value['submissionCommitment'])) && (kind !== 'seal' || isDigest(value['archiveCommitment'])), 'Invalid commitment claims');
  fields(value['signer'], ['userId', 'displayName']);
  requireValid(nonempty(value['signer']['userId']) && string(value['signer']['displayName']), 'Invalid signer');
  if (kind === 'form') requireValid(['wdoc-attestation', 'personal'].includes(value['mode']), 'Invalid signature mode');
  const platform = kind !== 'form' || value['mode'] === 'wdoc-attestation';
  fields(value['evidence'], ['scope', ...(platform ? ['method', 'consent'] : [])], platform ? [] : ['method', 'consent']);
  requireValid(value['evidence']['scope'] === 'commitment-only', 'Invalid evidence');
  optional(value['evidence'], 'method', v => v === 'authenticated-session');
  optional(value['evidence'], 'consent', v => v === 'wdoc-sign-v1');
}
export function validKid(value: unknown): value is string {
  if (typeof value !== 'string' || /[^\x21-\x7e]/.test(value) || !/^https:\/\/[^/?#@]+\/info\/[A-Za-z0-9_-]+$(?![\s\S])/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && /^\/info\/[A-Za-z0-9_-]+$(?![\s\S])/.test(url.pathname); } catch { return false; }
}
export function assertKeyRegistry(value: unknown, allowedOrigins?: string[]): asserts value is KeyRecord[] {
  requireValid(Array.isArray(value), 'Invalid key registry');
  if (allowedOrigins !== undefined) requireValid(Array.isArray(allowedOrigins) && allowedOrigins.every(o => { try { return new URL(o).origin === o && o.startsWith('https://'); } catch { return false; } }) && new Set(allowedOrigins).size === allowedOrigins.length, 'Invalid key origins');
  const ids = new Set<string>();
  for (const k of value) {
    fields(k, ['kid', 'jwk', 'status', 'trusted', 'authority', 'owner'], ['userId', 'notBefore', 'expiresAt']);
    requireValid(validKid(k['kid']) && !ids.has(k['kid']) && (allowedOrigins === undefined || allowedOrigins.includes(new URL(k['kid']).origin)), 'Unauthorized key origin or duplicate KID'); ids.add(k['kid']);
    requireValid(['active', 'retired', 'revoked'].includes(k['status']) && typeof k['trusted'] === 'boolean' && ['platform', 'personal'].includes(k['authority']) && nonempty(k['owner']), 'Invalid key policy');
    optional(k, 'userId', nonempty); optional(k, 'notBefore', isDateTime); optional(k, 'expiresAt', isDateTime);
    requireValid(k['authority'] !== 'personal' || nonempty(k['userId']), 'Missing personal key identity');
    requireValid(!k['notBefore'] || !k['expiresAt'] || Date.parse(k['notBefore']) < Date.parse(k['expiresAt']), 'Invalid key validity interval');
    fields(k['jwk'], ['kty', 'crv', 'x', 'y'], [], true);
    requireValid(k['jwk']['kty'] === 'EC' && k['jwk']['crv'] === 'P-256' && isDigest(k['jwk']['x']) && isDigest(k['jwk']['y']) && !Object.hasOwn(k['jwk'], 'd'), 'Invalid public key');
    optional(k['jwk'], 'alg', v => v === 'ES256'); optional(k['jwk'], 'use', v => v === 'sig'); optional(k['jwk'], 'kid', string);
    optional(k['jwk'], 'key_ops', v => Array.isArray(v) && v.every(string) && v.includes('verify'));
  }
}

/** Independent transport budgets: history must not consume the document allowance. */
export function archiveBudget(entries: [string, number][]): void {
  const names = entries.map(([path]) => path);
  const roots = new Set(names.map(path => path.split('/')[0]));
  const prefix = !names.includes('index.html') && roots.size === 1 ? `${names[0]?.split('/')[0]}/` : '';
  let contentBytes = 0, contentCount = 0, gitBytes = 0, gitCount = 0;
  for (const [physical, size] of entries) {
    const path = physical.startsWith(prefix) ? physical.slice(prefix.length) : physical;
    if (!path) continue;
    if (path.startsWith('.git/')) {
      gitBytes += size; gitCount++;
      requireValid(size <= 100_000_000 && gitBytes <= 100_000_000 && gitCount <= 10_000, 'Git history exceeds limits');
    } else {
      contentBytes += size; contentCount++;
      requireValid(size <= 10_000_000 && contentBytes <= 30_000_000 && contentCount <= 1000, 'Expanded archive exceeds limits');
    }
  }
}
