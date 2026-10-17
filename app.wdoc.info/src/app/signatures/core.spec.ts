import { CompactSign, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { archiveCommitment, commitment, newNonce, snapshotCommitment, assertManifest, dependenciesValid, documentDigest, encoder, formIds, inventory, jcs, parseJson, safePath, sha256, verifyDocument, verifyJws, type Files, type KeyRecord, type Manifest } from './core';

describe('Portable wdoc verification', () => {
  let privateKey: KeyLike; let key: KeyRecord; let manifest: Manifest; let files: Files;
  const signedAt = '2026-10-17T09:00:00Z';
  const sign = async (type: string, data: object, header: object = {}) => new CompactSign(encoder.encode(jcs(data))).setProtectedHeader({ alg: 'ES256', typ: `wdoc-${type}+jws`, kid: key.kid, ...header }).sign(privateKey);
  const common = (kind: string, documentCommitment: string) => ({ type: `wdoc-${kind}-signature`, proofMode: 'digest-only', documentCommitment, signer: { userId: 'alice', displayName: 'Alice' }, signedAt, evidence: { method: 'authenticated-session', consent: 'wdoc-sign-v1', scope: 'commitment-only' } });
  const documentCommitment = async () => commitment('document', await documentDigest(manifest), manifest.signatures.document[0].nonce);
  const docSign = async () => {
    const nonce = newNonce();
    manifest.signatures.document = [{ signatureId: crypto.randomUUID(), nonce, jws: await sign('document', common('document', await commitment('document', await documentDigest(manifest), nonce))) }];
  };
  const formSign = async () => {
    files['submissions/s1/answers.json'] = encoder.encode('{"answer":"yes"}'); files['submissions/s1/attachments/proof.txt'] = encoder.encode('proof');
    const submission = { submissionId: 's1', answersFile: 'submissions/s1/answers.json', attachments: ['submissions/s1/attachments/proof.txt'], createdAt: signedAt, documentDigest: await documentDigest(manifest) };
    manifest.runtime.submissions['contract'] = [submission];
    const nonce = newNonce();
    const payload = { ...common('form', await documentCommitment()), mode: 'wdoc-attestation', submissionCommitment: await snapshotCommitment(manifest, 'contract', submission, files, nonce) };
    manifest.signatures.forms = [{ signatureId: 'form', formId: 'contract', submissionId: 's1', nonce, jws: await sign('form', payload) }];
    return payload;
  };
  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true }); privateKey = pair.privateKey;
    key = { kid: 'https://sig.wdoc.info/info/key-1', jwk: await exportJWK(pair.publicKey), status: 'active', trusted: true, authority: 'platform', owner: 'wdoc' };
  });
  beforeEach(async () => {
    files = { 'index.html': encoder.encode('<form id=contract><input name=answer></form>'), 'style.css': encoder.encode('body { color: black }') };
    manifest = { manifestVersion: '1.0', meta: { docId: 'doc-1', appVersion: '1', createdAt: signedAt, contentUpdatedAt: signedAt }, content: { hashAlgorithm: 'SHA-256', files: await inventory(files) }, runtime: { submissions: {}, revisions: [], forms: {} }, signatures: { document: [], forms: [] } };
  });
  it('canonicalizes RFC values and rejects ambiguous JSON and invalid Unicode', async () => {
    expect(jcs({ z: null, a: [1e30, 4.5, .002, 1e-27] })).toBe('{"a":[1e+30,4.5,0.002,1e-27],"z":null}');
    expect(jcs({ '😀': 1, '\r': 2, '\u20ac': 3 })).toBe('{"\\r":2,"€":3,"😀":1}');
    expect(() => jcs('\ud800')).toThrow(); expect(() => jcs('\udc00')).toThrow(); expect(() => jcs(Infinity)).toThrow(); expect(() => jcs(undefined)).toThrow(); expect(() => jcs(new Date())).toThrow();
    expect(() => parseJson('{"a":1,"\\u0061":2}')).toThrow(); expect(parseJson('{"a":[null,true]}')).toEqual({ a: [null, true] });
    expect(await sha256(encoder.encode('abc'))).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    for (const p of ['../bad', '/bad', 'a//b', 'a%2fb', 'a\\b', '__proto__/x', '']) expect(safePath(p)).toBeFalse();
    await expectAsync(inventory({ '../bad': encoder.encode('x') })).toBeRejected();
  });
  it('returns unsigned without treating matching hashes as authentication', async () => {
    const report = await verifyDocument(manifest, files, []); expect(report.document[0].status).toBe('unsigned'); expect(report.content.status).toBe('valid-untrusted');
    const bad = structuredClone(manifest); bad.manifestVersion = '2.0' as '1.0'; expect(() => assertManifest(bad)).toThrow();
    bad.manifestVersion = '1.0'; bad.content.files['../bad'] = 'x'; expect(() => assertManifest(bad)).toThrow();
  });
  it('authenticates exact original files and excludes evolving runtime', async () => {
    await docSign(); const before = await documentDigest(manifest);
    files['wdoc-form/draft.json'] = encoder.encode('{}'); manifest.runtime.updatedAt = '2026-10-18T00:00:00.000Z';
    expect(await documentDigest(manifest)).toBe(before);
    expect((await verifyDocument(manifest, files, [key])).document[0].status).toBe('valid-trusted');
    files['style.css'] = encoder.encode('tampered'); expect((await verifyDocument(manifest, files, [key])).document[0].status).toBe('file-modified');
    delete files['style.css']; expect((await verifyDocument(manifest, files, [key])).content.status).toBe('file-modified');
    files['style.css'] = encoder.encode('body { color: black }'); files['extra.css'] = encoder.encode('extra'); expect((await verifyDocument(manifest, files, [key])).document[0].status).toBe('file-modified');
    delete files['extra.css']; manifest.meta.docId = 'other'; expect((await verifyDocument(manifest, files, [key])).document[0].status).toBe('wrong-revision');
  });
  it('reports unknown, revoked, expired, retired and untrusted keys separately', async () => {
    await docSign(); const jws = manifest.signatures.document[0].jws;
    expect((await verifyJws(jws, 'document', [])).check.status).toBe('key-unavailable');
    expect((await verifyJws(jws, 'document', [{ ...key, trusted: false }])).check.status).toBe('valid-untrusted');
    expect((await verifyJws(jws, 'document', [{ ...key, status: 'retired' }])).check.status).toBe('valid-trusted');
    for (const record of [{ ...key, status: 'revoked' as const }, { ...key, expiresAt: '2000-01-01' }, { ...key, notBefore: '2100-01-01' }, { ...key, jwk: { ...key.jwk, d: 'secret' } }]) expect((await verifyJws(jws, 'document', [record])).check.status).toBe('key-unauthorized');
    expect((await verifyJws(jws, 'form', [key])).check.status).toBe('key-unauthorized');
    expect((await verifyJws('invalid', 'document', [key])).check.status).toBe('invalid-signature');
    const parts = jws.split('.'); parts[1] = btoa('{}'); expect((await verifyJws(parts.join('.'), 'document', [key])).check.status).toBe('invalid-signature');
    const none = btoa(JSON.stringify({ alg: 'none', kid: key.kid, typ: 'wdoc-document+jws' })).replace(/=/g, ''); expect((await verifyJws(`${none}.e30.`, 'document', [key])).check.status).toBe('key-unauthorized');
    const wrong = await sign('document', { type: 'wrong', signedAt }); expect((await verifyJws(wrong, 'document', [key])).check.status).toBe('invalid-signature');
  });
  it('binds forms to original revision, snapshot bytes, attachments and attestation authority', async () => {
    await docSign(); const payload = await formSign();
    expect((await verifyDocument(manifest, files, [key])).forms[0].status).toBe('valid-trusted');
    files['submissions/s1/answers.json'] = encoder.encode('changed'); expect((await verifyDocument(manifest, files, [key])).forms[0].status).toBe('file-modified');
    files['submissions/s1/answers.json'] = encoder.encode('{"answer":"yes"}'); delete files['submissions/s1/attachments/proof.txt']; expect((await verifyDocument(manifest, files, [key])).forms[0].status).toBe('file-modified');
    files['submissions/s1/attachments/proof.txt'] = encoder.encode('proof');
    manifest.signatures.forms[0].submissionId = 'wrong'; expect((await verifyDocument(manifest, files, [key])).forms[0].status).toBe('wrong-revision');
    manifest.signatures.forms[0].submissionId = 's1'; manifest.signatures.document = []; expect((await verifyDocument(manifest, files, [key])).forms[0].status).toBe('wrong-revision');
    await docSign(); manifest.signatures.forms[0].jws = await sign('form', { ...payload, evidence: { scope: 'commitment-only' }, mode: 'personal' }); expect((await verifyDocument(manifest, files, [key])).forms[0].status).toBe('key-unauthorized');
    manifest.signatures.forms = []; expect((await verifyDocument(manifest, files, [key])).forms[0].status).toBe('unsigned');
    manifest.runtime.submissions['contract'][0].attachments = ['../bad']; expect(() => assertManifest(manifest)).toThrow();
  });
  it('verifies personal identities only against the registry association', async () => {
    await docSign(); const payload = await formSign();
    manifest.signatures.forms[0].jws = await sign('form', { ...payload, evidence: { scope: 'commitment-only' }, mode: 'personal' }, { kid: 'https://identity.example/info/alice' });
    const personal: KeyRecord = { ...key, kid: 'https://identity.example/info/alice', authority: 'personal', userId: 'alice', owner: 'Alice' };
    expect((await verifyDocument(manifest, files, [key, personal])).forms[0].status).toBe('valid-trusted');
    expect((await verifyDocument(manifest, files, [key, { ...personal, userId: 'other' }])).forms[0].status).toBe('key-unauthorized');
  });
  it('verifies historical content without relabelling old forms as the current revision', async () => {
    await docSign(); await formSign(); const old = structuredClone(manifest); const digest = await documentDigest(old);
    const paths: Record<string, string> = {};
    for (const p of Object.keys(old.content.files)) { paths[p] = `revisions/${digest}/files/${p}`; files[paths[p]] = files[p]; }
    manifest.meta.appVersion = '2'; manifest.runtime.revisions.push({ scope: { manifestVersion: old.manifestVersion, meta: old.meta, content: old.content }, files: paths, signatures: old.signatures.document });
    await docSign(); const report = await verifyDocument(manifest, files, [key]); expect(report.revisions[0].status).toBe('valid-trusted'); expect(report.forms[0].status).toBe('valid-trusted');
    paths['style.css'] = '../bad'; await expectAsync(verifyDocument(manifest, files, [key])).toBeRejected();
  });
  it('seals actual manifest bytes and detects omitted submissions and added files', async () => {
    await docSign(); await formSign();
    const full = { ...files, 'manifest.json': encoder.encode(jcs(manifest)) };
    const nonce = newNonce();
    const payload = { ...common('seal', await documentCommitment()), archiveCommitment: await archiveCommitment(manifest, full, 'seal1', nonce) };
    files['seals/seal1.nonce'] = encoder.encode(nonce);
    files['seals/seal1.jws'] = encoder.encode(await sign('seal', payload));
    expect((await verifyDocument(manifest, files, [key])).seals[0].status).toBe('valid-trusted');
    files['manifest.json'] = encoder.encode(JSON.stringify(manifest, null, 2)); expect((await verifyDocument(manifest, files, [key])).seals[0].status).toBe('archive-changed'); delete files['manifest.json'];
    delete files['submissions/s1/answers.json']; expect((await verifyDocument(manifest, files, [key])).seals[0].status).toBe('archive-changed');
    files['seals/seal1.jws'] = encoder.encode(await sign('seal', { ...payload, documentCommitment: newNonce() })); expect((await verifyDocument(manifest, files, [key])).seals[0].status).toBe('wrong-revision');
  });
  it('rejects unprotected rendering dependencies, active content and ambiguous CSS', () => {
    expect(formIds('<form id=one></form><form></form>')).toEqual(['one', 'form-2']);
    const allowed = '<style>p:empty::before {content:"\\200B";}</style><link href="style.css" rel=stylesheet><style>p { background: url("#local") }</style><img src="data:image/png;base64,AAA=">';
    files['index.html'] = encoder.encode(allowed); expect(dependenciesValid(manifest, files)).toBeTrue();
    for (const html of ['<img src="submissions/photo.png">', '<img src="https://other.example/a.png">', '<base href="/">', '<script>bad()</script>', '<img srcset="a.png 1x">', '<style>p { background:url(https://bad.example/a) }</style>', '<div style="background:image-set(\'a\')"></div>', '<style>p { color: r\\65 d }</style>']) {
      files['index.html'] = encoder.encode(html); expect(dependenciesValid(manifest, files)).withContext(html).toBeFalse();
    }
  });
});
