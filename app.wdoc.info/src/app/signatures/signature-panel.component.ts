import { Component, ChangeDetectionStrategy, ChangeDetectorRef, Input, Output, EventEmitter, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WdocSignatureService, type DocumentState, type FormSnapshot } from './signature.service';
import { sha256, type Check, type Verification } from './core';

@Component({
  selector: 'app-signature-panel', standalone: true, imports: [CommonModule, FormsModule], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './signature-panel.component.html', styleUrls: ['./signature-panel.component.css'],
})
export class SignaturePanelComponent implements OnChanges {
  @Input() buffer: ArrayBuffer | null = null;
  @Input() formRoot: Document | ShadowRoot | HTMLElement | null = null;
  @Output() archiveChanged = new EventEmitter<ArrayBuffer>();
  state: DocumentState | null = null;
  report: Verification | null = null;
  busy = false; error = ''; message = ''; expanded = false;
  snapshot: FormSnapshot | null = null; preview = ''; consent = false;
  selectedForm = 0; attachmentNames: string[] = [];
  previewFiles: Array<{ name: string; size: number; hash: string; data: string }> = [];
  pendingCosign: { formId: string; submissionId: string } | null = null;
  includeFonts = false;
  private generation = 0;
  constructor(private service: WdocSignatureService, private cdr: ChangeDetectorRef) {}
  get forms(): HTMLFormElement[] { return Array.from(this.formRoot?.querySelectorAll('form') ?? []); }
  async ngOnChanges() {
    const generation = ++this.generation;
    if (!this.buffer) { this.state = null; this.report = null; return; }
    this.error = ''; this.snapshot = null; this.state = null; this.report = null; this.pendingCosign = null; this.preview = ''; this.previewFiles = [];
    try {
      const state = await this.service.read(this.buffer); const report = await this.service.verify(state);
      if (generation !== this.generation) return;
      this.state = state; this.report = report;
    } catch (e) { if (generation === this.generation) this.error = (e as Error).message; }
    this.cdr.markForCheck();
  }
  async review() {
    await this.run(async () => {
      if (!this.state || !this.forms[this.selectedForm]) return;
      this.snapshot = await this.service.collect(this.forms[this.selectedForm], this.selectedForm, this.state);
      this.preview = JSON.stringify(this.snapshot.answers, null, 2); this.attachmentNames = Object.keys(this.snapshot.attachments); this.consent = false; this.pendingCosign = null;
      await this.describeAttachments(this.snapshot.attachments);
    });
  }
  async signForm() {
    if (!this.consent) return;
    if (this.pendingCosign) {
      const { formId, submissionId } = this.pendingCosign;
      await this.mutate(`forms/${encodeURIComponent(formId)}/sign`, { submissionId, mode: 'wdoc-attestation', consent: true });
      this.pendingCosign = null; this.consent = false; return;
    }
    if (!this.snapshot) return;
    const snapshot = this.snapshot;
    const latest = this.state?.manifest.runtime.submissions[snapshot.formId]?.at(-1);
    await this.mutate(`forms/${encodeURIComponent(snapshot.formId)}/sign`, { answers: snapshot.answers, attachments: snapshot.attachments, ...(latest ? { replaces: latest.submissionId } : {}), mode: 'wdoc-attestation', consent: true });
    this.snapshot = null; this.consent = false;
  }
  async cosign(formId: string, submissionId: string) {
    this.showSnapshot(formId, submissionId);
    this.pendingCosign = { formId, submissionId }; this.consent = false;
  }
  async mutate(action: string, input: object = {}) {
    await this.run(async () => {
      if (!this.state) return;
      const generation = this.generation;
      const next = await this.service.operate(this.state, action, input);
      if (generation !== this.generation) return;
      this.state = next; this.report = await this.service.verify(next);
      const buffer = await this.service.archive(next);
      this.archiveChanged.emit(buffer);
      this.message = 'Signed locally. Download your archive to keep it; the document was not uploaded or saved on a server.';
    });
  }
  async download() { await this.run(async () => { if (this.state) this.service.download(await this.service.archive(this.state, this.includeFonts)); }); }
  showSnapshot(formId: string, submissionId: string) {
    const s = this.state?.manifest.runtime.submissions[formId]?.find(s => s.submissionId === submissionId);
    if (!s || !this.state) return;
    this.preview = new TextDecoder().decode(this.service.bytes(this.state)[s.answersFile]); this.attachmentNames = s.attachments; this.snapshot = null; this.pendingCosign = null;
    void this.describeAttachments(Object.fromEntries(s.attachments.filter(p => typeof this.state!.files[p] === 'string').map(p => [p, this.state!.files[p]])));
  }
  downloadAttachment(file: { name: string; data: string }) { this.service.downloadAttachment(file.name, file.data); }
  private async describeAttachments(files: Record<string, string>) {
    this.previewFiles = await Promise.all(Object.entries(files).map(async ([name, data]) => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      return { name, data, size: bytes.length, hash: await sha256(bytes) };
    }));
    this.cdr.markForCheck();
  }
  keyInfo(kid?: string) { return this.service.keys?.find(k => k.kid === kid); }
  label(check: Check): string {
    return ({ 'valid-trusted': 'Verified signature · trusted key', 'valid-untrusted': 'Cryptographically valid · identity not verified', 'file-modified': 'File modified or missing', 'invalid-signature': 'Invalid signature', 'key-unavailable': 'Public key unavailable', 'key-unauthorized': 'Key revoked, expired or unauthorized', 'wrong-revision': 'Document revision or reference mismatch', unsigned: 'Unsigned', 'archive-changed': 'Archive changed since this seal' })[check.status];
  }
  private async run(work: () => Promise<void>) {
    if (this.busy) return; this.busy = true; this.error = ''; this.message = '';
    try { await work(); } catch (e) { this.error = (e as Error).message; }
    finally { this.busy = false; this.cdr.markForCheck(); }
  }
}
