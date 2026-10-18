import { HistoryService } from '../history/history.service';
import { TestBed } from '@angular/core/testing';
import JSZip from 'jszip';
import { CompactSign, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { backendConfig } from '../config/app.config';
import { AuthService } from '../services/auth.service';
import { generateManifest } from '../services/manifest-builder';
import { WdocSignatureService, type DocumentState } from './signature.service';
import { EditedArchiveService } from '../services/edited-archive.service';
import { jcs, documentDigest, inspectFontResources, sha256, verifyDocument, verifyJws, type KeyRecord } from './core';

describe('WdocSignatureService', () => {
  let service: WdocSignatureService; let auth: jasmine.SpyObj<AuthService>; let state: DocumentState; let fetchSpy: jasmine.Spy;
  let key: KeyRecord; let privateKey: KeyLike; let personal: KeyRecord; let personalKey: KeyLike;
  const configuredOrigins = [...backendConfig.signingKeyOrigins];
  afterEach(() => { backendConfig.signingKeyOrigins = [...configuredOrigins]; });
  let api: (url: string, init?: RequestInit) => Promise<Response>;
  beforeAll(async () => { const pair = await generateKeyPair('ES256', { extractable: true }); privateKey = pair.privateKey; key = { kid: 'https://sig.wdoc.info/info/test', jwk: await exportJWK(pair.publicKey), trusted: true, status: 'active', authority: 'platform', owner: 'wdoc' }; const pair2 = await generateKeyPair('ES256', { extractable: true }); personalKey = pair2.privateKey; personal = { kid: 'https://identity.example/info/alice', jwk: await exportJWK(pair2.publicKey), trusted: true, status: 'active', authority: 'personal', owner: 'Alice', userId: 'alice' }; });
  beforeEach(async () => {
    backendConfig.signingKeyOrigins = [...configuredOrigins, 'https://identity.example'];
    auth = jasmine.createSpyObj<AuthService>('AuthService', ['getCurrentSession', 'getCurrentUserEmail']); auth.getCurrentSession.and.returnValue({ token: 'token', user: { id: 'alice', email: 'alice@example.com' } });
    auth.getCurrentUserEmail.and.returnValue(null);
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: auth }] }); service = TestBed.inject(WdocSignatureService);
    const zip = new JSZip(); zip.file('index.html', '<form id="contract"></form><form id="order"></form>'); zip.file('wdoc-form/proof.txt', 'old proof');
    zip.file('manifest.json', JSON.stringify(await generateManifest(zip), null, 2));
    state = await service.read(await zip.generateAsync({ type: 'arraybuffer' }));
    api = async (url, init) => {
      if (url.endsWith('/signing-keys')) return new Response(JSON.stringify({ keys: [key, personal] }));
      const body = JSON.parse(init?.body as string); const kind = url.split('/').pop();
      const claims = kind === 'document' ? { documentCommitment: body.documentCommitment } : { documentCommitment: (await verifyJws(body.documentProof, 'document', [key])).payload.documentCommitment, ...(kind === 'form' ? { submissionCommitment: body.submissionCommitment } : { archiveCommitment: body.archiveCommitment }) };
      const payload = { type: `wdoc-${kind}-signature`, proofMode: 'digest-only', ...claims, ...(kind === 'form' ? { mode: 'wdoc-attestation' } : {}), signer: { userId: 'alice', displayName: 'alice@example.com' }, signedAt: new Date().toISOString(), evidence: { method: 'authenticated-session', consent: 'wdoc-sign-v1', scope: 'commitment-only' } };
      const jws = await new CompactSign(new TextEncoder().encode(jcs(payload))).setProtectedHeader({ alg: 'ES256', typ: `wdoc-${kind}+jws`, kid: key.kid }).sign(privateKey);
      return new Response(JSON.stringify({ signatureId: crypto.randomUUID(), jws }));
    };
    fetchSpy = spyOn(window, 'fetch').and.callFake((url, init) => api(String(url), init));
  });
  it('reads and exports exact manifest bytes and accepts a manifestless document', async () => {
    expect(state.manifest.manifestVersion).toBe('0.1'); expect(state.manifestText).toContain('\n');
    const buffer = await service.archive(state); const roundtrip = await service.read(buffer);
    expect(roundtrip.files).toEqual(state.files); expect(roundtrip.manifestText).toBe(state.manifestText);
    expect(new TextDecoder().decode(service.bytes(state)['index.html'])).toContain('contract');
    const plain = new JSZip(); plain.file('index.html', '<p>Unsigned document</p>');
    const input = await plain.generateAsync({ type: 'arraybuffer' });
    const candidate = await service.read(input);
    expect(candidate.manifest.meta.docId).toBeTruthy(); expect(candidate.manifestText).toBeUndefined();
    expect((await service.verify(candidate)).document[0].status).toBe('unsigned');
    expect((await JSZip.loadAsync(input)).file('manifest.json')).toBeNull();
    expect(fetchSpy.calls.allArgs().some(args => args[1]?.method === 'POST')).toBeFalse();
  });
  it('keeps authentic signed history when a linked document is saved as an unsigned edit without login', async () => {
    const signed = await service.operate(state, 'sign');
    const sealed = await service.operate(signed, 'seal');
    const oldDigest = await documentDigest(sealed.manifest);
    const buffer = await service.archive(sealed);
    auth.getCurrentSession.and.returnValue(null); fetchSpy.calls.reset();
    const blob = await TestBed.inject(EditedArchiveService).build({ html: '<p>Local edit</p>', title: 'Local edit', version: '2.0.0', assets: [], includeFonts: false, original: buffer });
    const edited = await service.read(await blob.arrayBuffer());
    const report = await verifyDocument(edited.manifest, service.bytes(edited), [key]);
    expect(edited.manifest.signatures.document).toEqual([]);
    expect(edited.manifest.runtime.revisions[0].signatures).toEqual(sealed.manifest.signatures.document);
    expect(edited.files[`revisions/${oldDigest}/files/index.html`]).toBe(sealed.files['index.html']);
    expect(report.revisions[0].status).toBe('valid-trusted');
    expect(report.seals[0].status).toBe('archive-changed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('records history before sealing and never changes Git after the seal is inserted', async () => {
    state.files['.git/HEAD'] = btoa('ref: refs/heads/main\n');
    const history = TestBed.inject(HistoryService);
    let counter = 0;
    const publish = spyOn(history, 'publish').and.callFake(async buffer => {
      const zip = await JSZip.loadAsync(buffer);
      zip.file('.git/refs/heads/main', String(++counter).padStart(40, '0'));
      return zip.generateAsync({ type: 'arraybuffer' });
    });
    spyOn(history, 'saved').and.resolveTo();
    const signed = await service.operate(state, 'sign');
    const sealed = await service.operate(signed, 'seal');
    expect(publish).toHaveBeenCalledTimes(2);
    const report = await service.verify(sealed);
    expect(report.document[0].status).toBe('valid-trusted');
    expect(report.seals[0].status).toBe('valid-trusted');
    sealed.files['.git/refs/heads/main'] = btoa('changed history');
    const changed = await service.verify(sealed);
    expect(changed.document[0].status).toBe('valid-trusted'); expect(changed.seals[0].status).toBe('archive-changed');
  });
  it('preserves signatures and seals when a document is repacked in one enclosing folder', async () => {
    const signed = await service.operate(await service.operate(state, 'sign'), 'seal');
    const wrapped = new JSZip();
    for (const [path, bytes] of Object.entries(service.bytes(signed))) wrapped.file(`Report/${path}`, bytes, { createFolders: false });
    const reread = await service.read(await wrapped.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }));
    expect(reread.files).toEqual(signed.files); expect(reread.manifestText).toBe(signed.manifestText ?? jcs(signed.manifest));
    const report = await service.verify(reread);
    expect(report.document[0].status).toBe('valid-trusted'); expect(report.seals[0].status).toBe('valid-trusted');
    const output = await JSZip.loadAsync(await service.archive(reread));
    expect(output.file('index.html')).not.toBeNull(); expect(output.file('Report/index.html')).toBeNull();
  });
  it('opens and signs a manifestless document inside one folder', async () => {
    const zip = new JSZip(); zip.file('Report/index.html', '<p>Local document</p>', { createFolders: false });
    const input = await service.read(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(Object.keys(input.files)).toEqual(['index.html']);
    const signed = await service.operate(input, 'sign');
    expect((await service.verify(await service.read(await service.archive(signed)))).document[0].status).toBe('valid-trusted');
  });
  it('rejects unsafe paths and oversized archives', async () => {
    const zip = new JSZip(); zip.file('index.html', '<p>x</p>'); zip.file('../bad', 'bad');
    await expectAsync(service.read(await zip.generateAsync({ type: 'arraybuffer' }))).toBeRejectedWithError(/Unsafe.*archive path/) ;
    const oversized = new JSZip(); oversized.file('large.bin', new Uint8Array(10000001));
    await expectAsync(service.read(await oversized.generateAsync({ type: 'arraybuffer' }))).toBeRejectedWithError('Expanded archive exceeds limits');
  });
  it('treats registry failure as unavailable keys and exposes unsigned documents honestly', async () => {
    const report = await service.verify(state); expect(report.document[0].status).toBe('unsigned');
    expect(fetchSpy.calls.mostRecent().args[0]).toContain('/signing-keys');
    fetchSpy.and.rejectWith(new Error('offline')); expect((await service.verify(state)).document[0].status).toBe('unsigned');
  });
  it('sends only blinded commitments and applies the returned signature locally', async () => {
    const before = jcs(state); const signed = await service.operate(state, 'sign');
    expect(jcs(state)).toBe(before); expect(signed.manifest.meta).toEqual(state.manifest.meta);
    expect((await service.verify(signed)).document[0].status).toBe('valid-trusted');
    const sent = fetchSpy.calls.allArgs().filter(args => args[1]?.method === 'POST'); expect(sent.length).toBe(1);
    const body = JSON.parse(sent[0][1].body); expect(Object.keys(body).sort()).toEqual(['consent', 'documentCommitment', 'requestId']);
    expect(body.documentCommitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const marker of ['private-title', 'index.html', state.manifest.meta.docId, signed.manifest.signatures.document[0].nonce!]) expect(JSON.stringify(body)).not.toContain(marker);
  });
  it('pins external fonts for signing, keeps revisions bound, and embeds offline copies without changing protected scopes', async () => {
    const url = 'https://fonts.gstatic.com/s/test/font.woff2', font = new TextEncoder().encode('wOF2 test font bytes for signature integrity');
    fetchSpy.and.callFake((value, init) => String(value) === url ? Promise.resolve(new Response(font)) : api(String(value), init));
    const zip = new JSZip(); zip.file('index.html', `<style>@font-face{font-family:Example;src:url("${url}")}</style><p>Signed font document</p>`);
    const candidate = await service.read(await zip.generateAsync({type:'arraybuffer'}));
    const signed = await service.operate(candidate, 'sign');
    expect(signed.manifest.content.externalFonts?.[url]).toBe(await sha256(font));
    const sealed = await service.operate(signed, 'seal');
    const portable = await service.read(await service.archive(sealed, true));
    expect(await documentDigest(portable.manifest)).toBe(await documentDigest(sealed.manifest));
    expect(portable.manifestText).toBe(sealed.manifestText ?? jcs(sealed.manifest));
    expect(portable.files[`wdoc-font-cache/${await sha256(font)}`]).toBeTruthy();
    const report = await service.verify(portable); expect(report.document[0].status).toBe('valid-trusted'); expect(report.seals[0].status).toBe('archive-changed');
    expect((await inspectFontResources(portable.manifest, service.bytes(portable)))[0].status).toBe('embedded-verified');
    const revised = await service.operate(signed, 'revisions', { files: { 'index.html': btoa(`<style>@font-face{font-family:Example;src:url("${url}")}</style><p>Revised font content</p>`) }, externalFonts: signed.manifest.content.externalFonts, appVersion:'test', docTitle:'Revised' });
    expect((await service.verify(revised)).revisions[0].status).toBe('valid-trusted'); expect(revised.manifest.runtime.revisions[0].scope.content.externalFonts?.[url]).toBe(await sha256(font));
    for (const args of fetchSpy.calls.allArgs().filter(args => args[1]?.method === 'POST')) { expect(args[1].body).not.toContain(url); expect(args[1].body).not.toContain('test font bytes'); }
  });
  it('does not silently replace a present unsigned manifest when its original bytes changed', async () => {
    state.files['index.html'] = btoa('Changed original');
    await expectAsync(service.operate(state, 'sign')).toBeRejectedWithError(/Original content was modified/);
    expect(fetchSpy.calls.allArgs().some(args => args[1]?.method === 'POST')).toBeFalse();
  });
  it('requires a session and rejects forged replies without changing local data', async () => {
    auth.getCurrentSession.and.returnValue(null); await expectAsync(service.operate(state, 'sign')).toBeRejectedWithError(/Log in/); expect(fetchSpy).not.toHaveBeenCalled();
    auth.getCurrentSession.and.returnValue({ token: 'token', user: { id: 'alice', email: 'alice@example.com' } });
    fetchSpy.and.callFake(async (url: string) => url.endsWith('/signing-keys') ? new Response(JSON.stringify({ keys: [key, personal] })) : new Response(JSON.stringify({ signatureId: 'bad', jws: 'forged' })));
    const before = jcs(state); await expectAsync(service.operate(state, 'sign')).toBeRejectedWithError(/does not match/); expect(jcs(state)).toBe(before);
    fetchSpy.and.callFake(async (url: string) => url.endsWith('/signing-keys') ? new Response(JSON.stringify({ keys: [key, personal] })) : new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Access denied' } }), { status: 403 }));
    await expectAsync(service.operate(state, 'sign')).toBeRejectedWithError('Access denied');
  });
  it('retains request IDs, local salts and frozen submissions across transport failures', async () => {
    let fail = true;
    fetchSpy.and.callFake(async (url: string, init?: RequestInit) => { if (init?.method === 'POST' && fail) { fail = false; throw new Error('network'); } return api(url, init); });
    await expectAsync(service.operate(state, 'sign')).toBeRejected();
    const first = JSON.parse(fetchSpy.calls.allArgs().find(args => args[1]?.method === 'POST')![1].body);
    const signed = await service.operate(state, 'sign');
    const posts = fetchSpy.calls.allArgs().filter(args => args[1]?.method === 'POST'); expect(JSON.parse(posts[1][1].body)).toEqual(first);
    expect(signed.manifest.signatures.document).toHaveSize(1); expect(state.manifest.signatures.document).toHaveSize(0);
  });
  it('freezes answers and attachments locally, supports co-signing and corrections, and seals complete bytes', async () => {
    let signed = await service.operate(state, 'sign');
    const originalDigest = await documentDigest(signed.manifest);
    signed = await service.operate(signed, 'forms/contract/sign', { answers: { privateAnswer: ['private-title'] }, attachments: { 'private-attachment.txt': btoa('PRIVATE ATTACHMENT') }, mode: 'wdoc-attestation', consent: true });
    const first = signed.manifest.runtime.submissions['contract'][0]; const frozen = signed.files[first.answersFile];
    signed = await service.operate(signed, 'forms/contract/sign', { submissionId: first.submissionId, mode: 'wdoc-attestation', consent: true });
    signed = await service.operate(signed, 'forms/order/sign', { answers: { amount: [10] }, mode: 'wdoc-attestation', consent: true });
    signed = await service.operate(signed, 'forms/contract/sign', { replaces: first.submissionId, answers: { correction: [true] }, mode: 'wdoc-attestation', consent: true });
    expect(signed.files[first.answersFile]).toBe(frozen); expect(await documentDigest(signed.manifest)).toBe(originalDigest);
    let report = await service.verify(signed); expect(report.forms.map(c => c.status)).toEqual(Array(4).fill('valid-trusted'));
    signed = await service.operate(signed, 'seal'); const reopened = await service.read(await service.archive(signed)); report = await service.verify(reopened);
    expect(report.seals.map(c => c.status)).toEqual(['valid-trusted']); expect(Object.keys(signed.files).some(p => p.endsWith('.nonce'))).toBeTrue();
    const sent = JSON.stringify(fetchSpy.calls.allArgs().filter(args => args[1]?.method === 'POST').map(args => JSON.parse(args[1].body)));
    for (const marker of ['privateAnswer', 'private-title', 'private-attachment', 'PRIVATE ATTACHMENT', first.answersFile, first.submissionId]) expect(sent).not.toContain(marker);
    delete reopened.files[first.answersFile]; expect((await service.verify(reopened)).seals[0].status).toBe('archive-changed');
  });
  it('creates and signs revised content locally while preserving historical proofs', async () => {
    let signed = await service.operate(state, 'sign'); signed = await service.operate(signed, 'forms/contract/sign', { answers: {}, mode: 'wdoc-attestation', consent: true });
    const oldDigest = await documentDigest(signed.manifest);
    const revised = await service.operate(signed, 'revisions', { files: { 'index.html': btoa('<p>private revised content</p>') }, appVersion: '2', docTitle: 'private revised title', sign: true });
    const report = await service.verify(revised); expect(report.document[0].status).toBe('valid-trusted'); expect(report.revisions[0].status).toBe('valid-trusted'); expect(report.forms[0].status).toBe('valid-trusted');
    expect(revised.files[`revisions/${oldDigest}/files/index.html`]).toBe(signed.files['index.html']);
    const sent = JSON.stringify(fetchSpy.calls.allArgs().filter(args => args[1]?.method === 'POST'));
    expect(sent).not.toContain('private revised title'); expect(sent).not.toContain('private revised content');
  });
  it('blocks conflicting local operations, invalid form references, unsafe attachments and damaged snapshots before upload', async () => {
    const first = service.operate(state, 'sign'); await expectAsync(service.operate(state, 'sign')).toBeRejectedWithError(/already in progress/); const signed = await first;
    const input = { answers: {}, mode: 'wdoc-attestation', consent: true };
    await expectAsync(service.operate(signed, 'forms/unknown/sign', input)).toBeRejectedWithError(/not found/);
    await expectAsync(service.operate(signed, 'forms/contract/sign', { ...input, consent: false })).toBeRejectedWithError(/consent/);
    await expectAsync(service.operate(signed, 'forms/contract/sign', { ...input, attachments: { '../bad': btoa('bad') } })).toBeRejectedWithError(/Unsafe/);
    await expectAsync(service.operate(signed, 'forms/contract/sign', { ...input, replaces: 'missing' })).toBeRejected();
    await expectAsync(service.operate(signed, 'forms/contract/sign', { mode: 'wdoc-attestation', consent: true })).toBeRejectedWithError(/Answers/);
    const submitted = await service.operate(signed, 'forms/contract/sign', input); const sub = submitted.manifest.runtime.submissions['contract'][0];
    await expectAsync(service.operate(submitted, 'forms/contract/sign', { ...input, submissionId: sub.submissionId })).toBeRejectedWithError(/unchanged/);
    submitted.files[sub.answersFile] = btoa('tampered'); await expectAsync(service.operate(submitted, 'forms/contract/sign', { mode: 'wdoc-attestation', consent: true, submissionId: sub.submissionId })).toBeRejectedWithError(/damaged/);
    await expectAsync(service.operate(submitted, 'seal')).toBeRejectedWithError(/verify locally/);
    await expectAsync(service.operate(signed, 'forms/..%2Fbad/sign', input)).toBeRejectedWithError(/Invalid form/);
    await expectAsync(service.operate(signed, 'access', { email: 'person@example.com' })).toBeRejectedWithError(/Unsupported/);
  });
  it('requires a local private-mode original signature and rejects modified original resources', async () => {
    await expectAsync(service.operate(state, 'forms/contract/sign', { answers: {}, mode: 'wdoc-attestation', consent: true })).toBeRejectedWithError(/Sign the original/);
    const damaged = structuredClone(state); damaged.files['index.html'] = btoa('tampered'); await expectAsync(service.operate(damaged, 'sign')).toBeRejectedWithError(/Original content/);
    const signed = await service.operate(state, 'sign');
    await expectAsync(service.operate(signed, 'revisions', { files: { 'wdoc-form/data.json': btoa('{}') }, appVersion: '2', docTitle: 'New' })).toBeRejectedWithError(/Invalid original/);
    await expectAsync(service.operate(signed, 'revisions', { files: { 'index.html': btoa('<img src="https://outside.example/image.png">') }, appVersion: '2', docTitle: 'New' })).toBeRejectedWithError(/rendering/);
  });
  it('supports a personal provider locally without sending its snapshot to the backend', async () => {
    const signed = await service.operate(state, 'sign'); fetchSpy.calls.reset();
    const prepared = await service.preparePersonal(signed, 'contract', { consent: true, answers: { confidential: ['SECRET'] } }, personal.kid);
    const jws = await new CompactSign(new TextEncoder().encode(jcs(prepared.payload))).setProtectedHeader({ alg: 'ES256', typ: 'wdoc-form+jws', kid: personal.kid }).sign(personalKey);
    const result = await service.completePersonal(prepared, jws); expect((await service.verify(result)).forms[0].authority).toBe('personal');
    expect(fetchSpy.calls.allArgs().filter(args => args[1]?.method === 'POST')).toHaveSize(0);
    await expectAsync(service.completePersonal(prepared, 'forged')).toBeRejectedWithError(/Personal signature/);
    await expectAsync(service.preparePersonal(signed, 'contract', { consent: true, answers: {} }, key.kid)).toBeRejectedWithError(/trusted personal/);
    await expectAsync(service.operate(signed, 'forms/contract/sign', { mode: 'personal' })).toBeRejectedWithError(/local personal/);
  });
  it('captures repeated controls, unchecked boxes, selected files and saved attachments exactly', async () => {
    const form = document.createElement('form'); form.id = 'contract';
    form.innerHTML = '<input name="name" value="Alice"><input name="name" value="Second"><input name="accept" type="checkbox"><input name="new" type="file"><input name="old" type="file" data-saved-file="proof.txt"><input name="empty" type="file">';
    const dt = new DataTransfer(); dt.items.add(new File(['proof'], 'proof.txt')); form.querySelector<HTMLInputElement>('[name=new]')!.files = dt.files;
    const snapshot = await service.collect(form, 0, state);
    expect(snapshot.answers['name']).toEqual(['Alice', 'Second']); expect(snapshot.answers['accept']).toEqual([]); expect(snapshot.answers['empty']).toEqual([null]);
    expect(snapshot.attachments['1-proof.txt']).toBe(btoa('proof')); expect(snapshot.attachments['2-proof.txt']).toBe(btoa('old proof'));
    expect(snapshot.answers['new']).toEqual([{ attachment: '1-proof.txt', size: 5 }]);
    form.id = ''; expect((await service.collect(form, 1, state)).formId).toBe('form-2');
    form.id = '../bad'; await expectAsync(service.collect(form, 0, state)).toBeRejected();
    form.id = 'contract'; spyOn(form, 'reportValidity').and.returnValue(false); await expectAsync(service.collect(form, 0, state)).toBeRejectedWithError(/required form/);
  });
  it('downloads a portable archive', () => {
    spyOn(URL, 'createObjectURL').and.returnValue('blob:signed'); const revoke = spyOn(URL, 'revokeObjectURL'); const click = spyOn(HTMLAnchorElement.prototype, 'click');
    service.download(new ArrayBuffer(0)); expect(click).toHaveBeenCalled(); expect(revoke).toHaveBeenCalledWith('blob:signed');
  });

  it('does not trust duplicate, malformed or out-of-policy browser registries', async () => {
    const signed=await service.operate(state,'sign');
    for (const records of [[key,key],[{...key,trusted:'true'}],[{...key,kid:'https://unexpected.example/info/key'}],[{...key,jwk:{...key.jwk,x:'A'.repeat(43),y:'A'.repeat(43)}}]]) {
      fetchSpy.and.resolveTo(new Response(JSON.stringify({keys:records})));
      expect((await service.verify(signed)).document[0].status).toBe('key-unavailable');expect(service.keys).toEqual([]);
    }
    fetchSpy.and.resolveTo(new Response('{"keys":[],"keys":'+JSON.stringify([key])+'}'));
    expect((await service.verify(signed)).document[0].status).toBe('key-unavailable');
  });

  it('rejects missing, unsupported and malformed manifest versions', async () => {
    const zip=new JSZip();zip.file('index.html','<p>Document</p>');
    for (const value of [{manifestVersion:'2.0',meta:{}},{meta:{docTitle:'Missing inventories'}}]) {
      zip.file('manifest.json',JSON.stringify(value));
      await expectAsync(service.read(await zip.generateAsync({type:'arraybuffer'}))).toBeRejected();
    }
  });
});
