import { CompactSign, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { assertFiles, assertKeyRegistry, assertManifest, base64url, commitment, decodeBase64url, decodeUtf8, documentDigest, encoder, inventory, isDateTime, jcs, newNonce, parseJson, scopeOf, verifyDocument, verifyJws, type Files, type KeyRecord, type Manifest } from './core';

// These cases test independently specified rejection boundaries, not private helpers.
describe('Strict format conformance', () => {
  const now = '2026-10-17T09:00:00.000Z';
  let files: Files; let manifest: Manifest; let key: KeyRecord; let privateKey: KeyLike; let rawKey: CryptoKey;
  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true }); privateKey = pair.privateKey;
    key = { kid: 'https://sig.wdoc.info/info/conformance', jwk: await exportJWK(pair.publicKey), status: 'active', trusted: true, authority: 'platform', owner: 'wdoc' };
    rawKey = await crypto.subtle.importKey('jwk', await exportJWK(pair.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  });
  beforeEach(async () => {
    files = { 'index.html': encoder.encode('<form id="approval"></form>') };
    manifest = { manifestVersion: '1.0', meta: { docId: 'document', appVersion: '1', createdAt: now, contentUpdatedAt: now }, content: { hashAlgorithm: 'SHA-256', files: await inventory(files) }, runtime: { forms: {}, submissions: {}, revisions: [] }, signatures: { document: [], forms: [] } };
  });
  const sign = async (payload: unknown, header = {}) => new CompactSign(encoder.encode(jcs(payload))).setProtectedHeader({ alg: 'ES256', typ: 'wdoc-document+jws', kid: key.kid, ...header }).sign(privateKey);
  const rawSign = async (payload: unknown, header: object) => {
    const input = `${base64url(encoder.encode(JSON.stringify({alg:'ES256',typ:'wdoc-document+jws',kid:key.kid,...header})))}.${base64url(encoder.encode(jcs(payload)))}`;
    const signature = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},rawKey,encoder.encode(input));
    return `${input}.${base64url(new Uint8Array(signature))}`;
  };
  const claims = (documentCommitment: string) => ({ type: 'wdoc-document-signature', proofMode: 'digest-only', documentCommitment, signer: { userId: 'alice', displayName: '' }, signedAt: now, evidence: { method: 'authenticated-session', consent: 'wdoc-sign-v1', scope: 'commitment-only' } });

  it('enforces closed manifest structures, property types, identifiers and dates', () => {
    const mutations: Array<(m: any) => void> = [
      m => m.extra = true, m => m.meta = [], m => m.meta.appVersion = '', m => m.meta.docId = 'constructor',
      m => m.meta.docTitle = 3, m => m.meta.creator = null, m => m.meta.createdAt = '2026-02-30T00:00:00Z',
      m => m.content.hashAlgorithm = 'sha256', m => delete m.content.files['index.html'], m => m.content.files = [],
      m => m.content.files['manifest.json'] = 'A'.repeat(43), m => m.content.files['wdoc-form/a'] = 'A'.repeat(43), m => m.content.files['index.html'] = 'B'.repeat(43),
      m => m.runtime = [], m => m.runtime.updatedAt = 'later', m => m.runtime.forms = [], m => m.runtime.forms.default = {},
      m => m.runtime.submissions = [], m => m.runtime.revisions = {}, m => m.signatures.extra = [], m => m.signatures.forms = {},
      m => m.signatures.document = [{ signatureId: 'bad/id', jws: 'e30.e30.AA' }],
      m => m.signatures.document = [{ signatureId: 'ok', jws: 'not-jws' }],
      m => m.signatures.document = [{ signatureId: 'ok', jws: 'e30.e30.AA', nonce: 'B'.repeat(43) }],
      m => m.signatures.document = [{ signatureId: 'ok', jws: 'e30.e30.AA', extra: true }],
      m => m.signatures.document = [{ signatureId: 'same', jws: 'e30.e30.AA' }, { signatureId: 'same', jws: 'e30.e30.AA' }],
    ];
    for (const mutate of mutations) { const m = structuredClone(manifest); mutate(m); expect(() => assertManifest(m)).toThrow(); }
    Object.assign(manifest.meta, { docTitle: 'Title', creator: 'alice', docVersion: '1', extension: { intact: true } });
    manifest.content['extension'] = 1;
    expect(() => assertManifest(manifest)).not.toThrow();
    expect(jcs(scopeOf(manifest))).toContain('extension');
  });

  it('checks snapshot path relationships, global IDs and complete historical maps', async () => {
    const sub = { submissionId: 's1', answersFile: 'submissions/s1/answers.json', attachments: ['submissions/s1/attachments/proof.txt'], createdAt: now, documentDigest: await documentDigest(manifest) };
    manifest.runtime.submissions['approval'] = [sub];
    expect(() => assertManifest(manifest)).not.toThrow();
    for (const change of [ { answersFile: 'submissions/s2/answers.json' }, { attachments: ['submissions/s2/attachments/proof.txt'] }, { attachments: ['submissions/s1/attachments/nested/proof.txt'] }, { attachments: ['submissions/s1/attachments/proof.txt', 'submissions/s1/attachments/proof.txt'] }, { documentDigest: 'wrong' }, { createdAt: 'invalid' }, { replaces: 1 }, { extra: true } ]) {
      const m = structuredClone(manifest); Object.assign(m.runtime.submissions['approval'][0], change); expect(() => assertManifest(m)).toThrow();
    }
    const duplicated = structuredClone(manifest); duplicated.runtime.submissions['other'] = [sub]; expect(() => assertManifest(duplicated)).toThrow();
    const original = structuredClone(manifest); original.meta.appVersion = 'old'; const digest = await documentDigest(original);
    const revision = { scope: scopeOf(original), files: { 'index.html': `revisions/${digest}/files/index.html` }, signatures: [{ signatureId: 'old', jws: 'e30.e30.AA', nonce: 'A'.repeat(43) }] };
    manifest.runtime.revisions.push(revision); expect(() => assertManifest(manifest)).not.toThrow();
    for (const mutate of [ (m: any) => m.runtime.revisions[0].scope.meta.docId = 'other', (m: any) => m.runtime.revisions[0].extra = true, (m: any) => m.runtime.revisions[0].files = {}, (m: any) => m.runtime.revisions[0].files.extra = 'revisions/extra', (m: any) => m.signatures.document = [{ signatureId: 'old', jws: 'e30.e30.AA' }] ]) {
      const m = structuredClone(manifest); mutate(m); expect(() => assertManifest(m)).toThrow();
    }
    const duplicateScope = structuredClone(manifest); duplicateScope.runtime.revisions.push({ ...structuredClone(revision), signatures: [] });
    await expectAsync(verifyDocument(duplicateScope, files, [])).toBeRejectedWithError('Duplicate historical scope');
    const sameScope = structuredClone(manifest); sameScope.runtime.revisions[0].scope = scopeOf(sameScope);
    await expectAsync(verifyDocument(sameScope, files, [])).toBeRejectedWithError('Duplicate historical scope');
    const duplicateSeal = structuredClone(manifest); files['seals/old.jws'] = encoder.encode('e30.e30.AA');
    await expectAsync(verifyDocument(duplicateSeal, files, [])).toBeRejectedWithError('Invalid or duplicate seal ID');
  });

  it('rejects replacement decoding, BOMs, noncanonical base64url and invalid JSON objects', () => {
    expect(decodeUtf8(encoder.encode('Valid Unicode 😀'))).toBe('Valid Unicode 😀');
    expect(() => decodeUtf8(new Uint8Array([0xc3, 0x28]))).toThrow();
    expect(() => decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow();
    expect(Array.from(decodeBase64url('Zg'))).toEqual([102]);
    for (const text of ['Zh', 'Zg==', '', 'Zg+']) expect(() => decodeBase64url(text)).toThrow();
    const cycle: any = {}; cycle.self = cycle;
    for (const value of [cycle, new Array(1), { value: Symbol() }, { value: NaN }]) expect(() => jcs(value)).toThrow();
    const symbols = { [Symbol()]: true }; expect(() => jcs(symbols)).toThrow();
    expect(() => jcs(JSON.parse('['.repeat(65) + '0' + ']'.repeat(65)))).toThrow();
    expect(() => parseJson('{"alg":"none","\\u0061lg":"ES256"}')).toThrow();
    for (const value of ['2026-10-17', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00', now + '\n']) expect(isDateTime(value)).toBeFalse();
    for (const value of [now, '2028-02-29T00:00:00Z', '2026-10-17t12:34:56.123456+02:30']) expect(isDateTime(value)).toBeTrue();
    expect(() => assertFiles({ '../bad': encoder.encode('x') })).toThrow();
    expect(() => assertFiles({ 'large.bin': new Uint8Array(10_000_001) })).toThrow();
  });

  it('verifies the actual parsed manifest, without requiring canonical file whitespace', async () => {
    const nonce = newNonce(), data = claims(await commitment('document', await documentDigest(manifest), nonce));
    manifest.signatures.document.push({ signatureId: 'document-proof', nonce, jws: await sign(data) });
    files['manifest.json'] = encoder.encode(JSON.stringify(manifest, null, 2));
    expect((await verifyDocument(manifest, files, [key])).document[0].status).toBe('valid-trusted');
    const mismatched = structuredClone(manifest); mismatched.meta['docTitle'] = 'Changed';
    await expectAsync(verifyDocument(mismatched, files, [key])).toBeRejectedWithError('Parsed manifest differs from archive bytes');
  });

  it('rejects ambiguous protected headers and closed-payload violations after valid signature math', async () => {
    const nonce = newNonce(), data = claims(await commitment('document', await documentDigest(manifest), nonce));
    expect((await verifyJws(await sign(data), 'document', [key])).check.status).toBe('valid-trusted');
    for (const header of [{ jku: null }, { b64: true }, { crit: [] }, { extra: 'ignored-before' }, { kid: 'http://sig.wdoc.info/info/key' }]) {
      expect((await verifyJws(await rawSign(data, header), 'document', [key])).check.status).toBe('key-unauthorized');
    }
    const protectedText = `{"alg":"none","alg":"ES256","typ":"wdoc-document+jws","kid":${JSON.stringify(key.kid)}}`;
    const input = `${base64url(encoder.encode(protectedText))}.${base64url(encoder.encode(jcs(data)))}`;
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rawKey, encoder.encode(input)));
    expect((await verifyJws(`${input}.${base64url(signature)}`, 'document', [key])).check.status).toBe('invalid-signature');
    for (const change of [ { extra: true }, { proofMode: 'future' }, { documentCommitment: 'B'.repeat(43) }, { signedAt: '2026-02-30T00:00:00Z' }, { signer: { userId: 'alice', displayName: 'Alice', email: 'extra' } }, { evidence: { ...data.evidence, extra: true } }, { evidence: { scope: 'commitment-only' } } ]) {
      expect((await verifyJws(await sign({ ...data, ...change }), 'document', [key])).check.status).toBe('invalid-signature');
    }
    expect((await verifyJws(await sign({ type: 'wdoc-document-signature', docId: 'document', documentDigest: data.documentCommitment, signedAt: now, extra: true }), 'document', [key])).check.status).toBe('invalid-signature');
  });

  it('validates externally supplied registry policy before considering trust', () => {
    expect(() => assertKeyRegistry([key], ['https://sig.wdoc.info'])).not.toThrow();
    for (const change of [ { extra: true }, { trusted: 'true' }, { authority: 'other' }, { status: 'other' }, { owner: '' }, { expiresAt: 'yesterday' }, { kid: 'https://sig.wdoc.info/info/key?query=1' }, { jwk: { ...key.jwk, d: '' } }, { jwk: { ...key.jwk, use: 'enc' } }, { jwk: { ...key.jwk, key_ops: ['sign'] } }, { jwk: { ...key.jwk, x: 'B'.repeat(43) } }, { authority: 'personal' } ]) {
      expect(() => assertKeyRegistry([{ ...key, ...change }])).toThrow();
    }
    expect(() => assertKeyRegistry([key, key])).toThrow();
    expect(() => assertKeyRegistry([key], ['https://other.example'])).toThrow();
    expect(() => assertKeyRegistry([key], ['https://sig.wdoc.info/'])).toThrow();
    expect(() => assertKeyRegistry([{ ...key, notBefore: now, expiresAt: now }])).toThrow();
    expect(() => assertKeyRegistry([{ ...key, authority: 'personal', userId: 'alice' }])).not.toThrow();
  });

  it('requires a declared manifest version and commitment-only payloads', async () => {
    const missing = structuredClone(manifest) as any; delete missing.manifestVersion;
    expect(() => assertManifest(missing)).toThrow();
    expect(() => assertManifest({ meta: {}, content: {}, runtime: {} })).toThrow();
    const inventoryPayload = { type: 'wdoc-document-signature', docId: 'document', documentDigest: await documentDigest(manifest), signedAt: now };
    expect((await verifyJws(await sign(inventoryPayload), 'document', [key])).check.status).toBe('invalid-signature');
    const unsignedWrapper = structuredClone(manifest) as any;
    unsignedWrapper.signatures.document = [{ signatureId: 'missing-nonce', jws: 'e30.e30.AA' }];
    expect(() => assertManifest(unsignedWrapper)).toThrow();
    manifest.runtime.forms = { default: { hashAlgorithm: 'SHA-256', files: { 'wdoc-form/approval.json': 'A'.repeat(43) } } };
    expect(() => assertManifest(manifest)).not.toThrow();
    manifest.runtime.forms = { default: { hashAlgorithm: 'sha256', files: {} } };
    expect(() => assertManifest(manifest)).toThrow();
  });
});
