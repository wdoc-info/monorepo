import { TestBed } from '@angular/core/testing';
import JSZip from 'jszip';
import { AuthService } from './auth.service';
import { EditedArchiveService } from './edited-archive.service';
import { generateManifest } from './manifest-builder';
import { WdocSignatureService } from '../signatures/signature.service';
import { documentDigest, verifyDocument } from '../signatures/core';

describe('EditedArchiveService', () => {
  let service: EditedArchiveService;
  let signatures: WdocSignatureService;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: { getCurrentUserEmail: () => null, getCurrentSession: () => null } }] });
    service = TestBed.inject(EditedArchiveService); signatures = TestBed.inject(WdocSignatureService);
  });
  const input = { html: '<p>Edited text</p>', version: '2.0.0', title: 'Edited document', assets: [], includeFonts: false };

  it('builds a new archive when there is no previous file', async () => {
    const output = await JSZip.loadAsync(await (await service.build({ ...input, original: null })).arrayBuffer());
    expect(await output.file('index.html')!.async('text')).toContain('Edited text');
    expect(JSON.parse(await output.file('manifest.json')!.async('text')).manifestVersion).toBe('0.1');
  });

  it('keeps document identity, local image/link resources, attachments, and form drafts on repeated unsigned saves', async () => {
    const zip = new JSZip();
    zip.file('index.html', '<p>Original text</p>'); zip.file('images/photo.png', 'image bytes');
    zip.file('wdoc-attachment/guide.pdf', 'PDF bytes'); zip.file('wdoc-form/answer.json', '{"name":"Alice"}');
    const originalManifest = await generateManifest(zip); zip.file('manifest.json', JSON.stringify(originalManifest));
    const original = await zip.generateAsync({ type: 'arraybuffer' });
    const assets = [{ path: 'images/photo.png', file: new Blob(['image bytes']), objectUrl: 'blob:original-photo' }, { path: 'wdoc-attachment/guide.pdf', file: new Blob(['PDF bytes']), objectUrl: 'blob:original-link' }];
    let blob = await service.build({ ...input, original, assets, html: '<p>Edited text</p><img src="blob:original-photo"><a href="blob:original-link#page=2">Guide</a>' });
    let output = await JSZip.loadAsync(await blob.arrayBuffer());
    const html = await output.file('index.html')!.async('text');
    expect(html).toContain('src="images/photo.png"'); expect(html).toContain('href="wdoc-attachment/guide.pdf#page=2"');
    expect(html).not.toContain('blob:');
    expect(await output.file('images/photo.png')!.async('text')).toBe('image bytes');
    expect(await output.file('wdoc-attachment/guide.pdf')!.async('text')).toBe('PDF bytes');
    expect(await output.file('wdoc-form/answer.json')!.async('text')).toContain('Alice');
    blob = await service.build({ ...input, original: await blob.arrayBuffer() });
    output = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = JSON.parse(await output.file('manifest.json')!.async('text'));
    expect(manifest.meta.docId).toBe(originalManifest.meta.docId);
    expect(manifest.meta.createdAt).toBe(originalManifest.meta.createdAt);
    expect(manifest.runtime.revisions).toEqual([]);
    const state = await signatures.read(await blob.arrayBuffer());
    expect((await verifyDocument(state.manifest, signatures.bytes(state), [])).content.status).not.toBe('file-modified');
  });

  it('preserves historical scopes without requiring login or sending an attestation', async () => {
    const fetcher = spyOn(window, 'fetch').and.rejectWith(new Error('No network expected'));
    const zip = new JSZip(); zip.file('index.html', '<p>Original text</p>');
    let state = await signatures.read(await zip.generateAsync({ type: 'arraybuffer' }));
    const firstDigest = await documentDigest(state.manifest);
    state = await signatures.reviseUnsigned(state, { files: { 'index.html': btoa('<p>Second version</p>') }, appVersion: 'test', docTitle: 'Second' });
    const secondDigest = await documentDigest(state.manifest);
    const blob = await service.build({ ...input, original: await signatures.archive(state) });
    const final = await signatures.read(await blob.arrayBuffer());
    expect(final.manifest.runtime.revisions.length).toBe(2);
    expect(final.manifest.signatures.document).toEqual([]);
    expect(final.files[`revisions/${firstDigest}/files/index.html`]).toBe(btoa('<p>Original text</p>'));
    expect(final.files[`revisions/${secondDigest}/files/index.html`]).toBe(btoa('<p>Second version</p>'));
    expect((await verifyDocument(final.manifest, signatures.bytes(final), [])).content.status).not.toBe('file-modified');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
