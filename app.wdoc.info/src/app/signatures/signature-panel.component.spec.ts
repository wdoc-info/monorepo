import { TestBed, ComponentFixture } from '@angular/core/testing';
import JSZip from 'jszip';
import { SignaturePanelComponent } from './signature-panel.component';
import { WdocSignatureService, type DocumentState } from './signature.service';
import { generateManifest } from '../services/manifest-builder';
import { encoder, type Manifest, type Verification, type Status } from './core';

describe('SignaturePanelComponent', () => {
  let fixture: ComponentFixture<SignaturePanelComponent>; let panel: SignaturePanelComponent; let service: jasmine.SpyObj<WdocSignatureService>; let state: DocumentState; let report: Verification;
  beforeEach(async () => {
    const zip = new JSZip(); zip.file('index.html', '<form id="contract"></form>');
    state = { manifest: await generateManifest(zip) as unknown as Manifest, files: {}, version: 0 };
    report = { documentDigest: 'digest', content: { status: 'valid-untrusted' }, document: [{ status: 'unsigned' }], forms: [], revisions: [], seals: [] };
    service = jasmine.createSpyObj<WdocSignatureService>('WdocSignatureService', ['read', 'verify', 'collect', 'operate', 'archive', 'download', 'downloadAttachment', 'bytes']);
    service.read.and.resolveTo(state); service.verify.and.resolveTo(report); service.operate.and.resolveTo(state); service.archive.and.resolveTo(new ArrayBuffer(5));
    TestBed.configureTestingModule({ imports: [SignaturePanelComponent], providers: [{ provide: WdocSignatureService, useValue: service }] });
    fixture = TestBed.createComponent(SignaturePanelComponent); panel = fixture.componentInstance; panel.buffer = new ArrayBuffer(1); await panel.ngOnChanges();
  });
  it('loads, verifies and renders distinct guarantees and statuses', () => {
    panel.expanded = true; fixture.detectChanges(); expect(fixture.nativeElement.textContent).toContain('Hashes match'); expect(fixture.nativeElement.textContent).toContain('stay on this device');
    const statuses: Status[] = ['valid-trusted', 'valid-untrusted', 'file-modified', 'invalid-signature', 'key-unavailable', 'key-unauthorized', 'wrong-revision', 'unsigned', 'archive-changed'];
    for (const status of statuses) expect(panel.label({ status }).length).toBeGreaterThan(5);
  });
  it('reviews frozen answers and only signs after explicit consent', async () => {
    const root = document.createElement('div'); root.innerHTML = '<form id=contract></form>'; panel.formRoot = root;
    const snapshot = { formId: 'contract', answers: { name: ['Alice'] }, attachments: { 'proof.txt': btoa('proof') } }; service.collect.and.resolveTo(snapshot);
    await panel.review(); expect(panel.preview).toContain('Alice'); expect(panel.attachmentNames).toEqual(['proof.txt']);
    await panel.signForm(); expect(service.operate).not.toHaveBeenCalled();
    panel.consent = true; const emit = spyOn(panel.archiveChanged, 'emit'); await panel.signForm(); expect(service.operate.calls.mostRecent().args[1]).toBe('forms/contract/sign'); expect(emit).toHaveBeenCalled(); expect(panel.snapshot).toBeNull();
  });
  it('creates corrections as new submissions and co-signs only reviewed snapshots', async () => {
    state.manifest.runtime.submissions['contract'] = [{ submissionId: 's1', answersFile: 'submissions/s1/answers.json', attachments: ['proof.txt'], createdAt: 'now', documentDigest: 'digest' }];
    state.files['proof.txt'] = btoa('proof');
    service.bytes.and.returnValue({ 'submissions/s1/answers.json': encoder.encode('{"name":"Alice"}') });
    panel.showSnapshot('contract', 's1'); expect(panel.preview).toContain('Alice'); expect(panel.snapshot).toBeNull();
    await panel.cosign('contract', 's1'); expect(panel.pendingCosign).toEqual({ formId: 'contract', submissionId: 's1' }); expect(service.operate).not.toHaveBeenCalled();
    panel.consent = true; await panel.signForm(); expect(service.operate.calls.mostRecent().args[2]).toEqual({ submissionId: 's1', mode: 'wdoc-attestation', consent: true });
    panel.snapshot = { formId: 'contract', answers: { name: ['New'] }, attachments: {} }; panel.consent = true; await panel.signForm();
    expect(service.operate.calls.mostRecent().args[2]).toEqual(jasmine.objectContaining({ replaces: 's1' }));
  });
  it('reports signing failures without claiming the document was stored remotely', async () => {
    service.operate.and.rejectWith(new Error('Forbidden')); await panel.mutate('sign'); expect(panel.error).toBe('Forbidden'); expect(panel.busy).toBeFalse();
    service.operate.and.resolveTo(state); await panel.mutate('sign'); expect(panel.message).toContain('not uploaded');
    service.read.and.rejectWith(new Error('Bad archive')); await panel.ngOnChanges(); expect(panel.error).toBe('Bad archive'); expect(panel.state).toBeNull();
  });
  it('does not apply stale asynchronous verification to a newer document', async () => {
    let resolve!: (s: DocumentState) => void; service.read.and.returnValue(new Promise(r => resolve = r));
    const pending = panel.ngOnChanges(); panel.buffer = null; await panel.ngOnChanges(); resolve(state); await pending; expect(panel.state).toBeNull();
    panel.showSnapshot('missing', 'missing'); await panel.mutate('sign'); await panel.download(); expect(service.operate).not.toHaveBeenCalled();
  });
  it('downloads the signed archive and shows progress without duplicate work', async () => {
    await panel.download(); expect(service.download).toHaveBeenCalled();
    panel.busy = true; await panel.review(); expect(service.collect).not.toHaveBeenCalled();
    panel.busy = false; await panel.review(); expect(service.collect).not.toHaveBeenCalled();
  });
});
