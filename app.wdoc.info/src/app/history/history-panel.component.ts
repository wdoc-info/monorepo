import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { HistoryService } from './history.service';
import { readDocumentArchive } from '../signatures/archive';
import { VisualMerge, preview, type VisualConflict } from './visual-merge';
import type { Snapshot } from './git-engine';

@Component({
  selector: 'app-history-panel', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="history">
      <button type="button" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()">Version history</button>
      <span role="status">{{ history.status() }}</span>
      @if (history.error()) { <p role="alert">{{ history.error() }}</p> }
      @if (history.recovery(); as draft) {
        <p>A local draft from {{ date(draft.savedAt) }} is available.
          <button type="button" (click)="restore.emit(draft.buffer)">Recover draft</button>
          <button type="button" (click)="history.saved()">Discard recovered draft</button>
        </p>
      }
      @if (expanded()) {
        <p>Versions travel inside this document. Authors and dates are declared metadata, not authenticated identities. Signatures remain bound to their exact content.</p>
        <label><input type="checkbox" [checked]="showAutosaves()" (change)="showAutosaves.set($any($event.target).checked)"> Show autosaves</label>
        <button type="button" [disabled]="busy" (click)="file.click()">Merge another version</button>
        <input #file type="file" accept=".wdoc,.zip" hidden (change)="importFile($event)">
        <ol aria-label="Document versions">
          @for (entry of history.entries(); track entry.oid) {
            @if (showAutosaves() || !entry.autosave) {
              <li><button type="button" [attr.aria-label]="'View version: ' + entry.message" (click)="inspect(entry.oid)">{{ entry.message }}</button>
                <small>{{ date(entry.date) }} · {{ entry.author }} · {{ entry.oid.slice(0, 7) }}{{ entry.parents.length > 1 ? ' · Merge' : '' }}</small>
                <button type="button" (click)="recover(entry.oid)" [disabled]="busy">Restore as draft</button>
              </li>
            }
          }
        </ol>
        @if (inspected()) {
          <p>{{ proofStatus() }}</p><iframe title="Version preview" sandbox="" [srcdoc]="inspected()"></iframe>
        }
      }
      @if (merge()) {
        <div role="region" aria-label="Visual version merge" class="merge">
          <h2>Merge document versions</h2>
          <p>{{ hasAncestor() ? 'Independent changes were merged automatically.' : 'No common ancestor was found. Choose the content to keep.' }} Imported signatures stay with the imported version; the result is an unsigned draft.</p>
          <div class="columns">
            <div><h3>Your version</h3><iframe title="Your version" sandbox="" [srcdoc]="oursPreview()"></iframe></div>
            <div><h3>Incoming version</h3><iframe title="Incoming version" sandbox="" [srcdoc]="theirsPreview()"></iframe></div>
          </div>
          @for (conflict of merge()!.conflicts; track $index) {
            <fieldset><legend>{{ conflict.label }}</legend>
              <button type="button" [attr.aria-pressed]="conflict.choice === 'ours'" (click)="choose(conflict, 'ours')">Keep yours</button>
              <button type="button" [attr.aria-pressed]="conflict.choice === 'theirs'" (click)="choose(conflict, 'theirs')">Keep incoming</button>
              @if (canEdit(conflict)) {
                <label>Resolved text<textarea [value]="conflict.text ?? ''" (input)="editText(conflict, $any($event.target).value)"></textarea></label>
              }
              @if (conflict.path !== 'index.html') { <p>{{ conflict.path }} · Yours: {{ conflict.ours?.length ?? 0 }} bytes · Incoming: {{ conflict.theirs?.length ?? 0 }} bytes</p> }
            </fieldset>
          }
          <button type="button" (click)="showResult()" [disabled]="!resolved()">Preview result</button>
          <button type="button" (click)="apply()" [disabled]="!resolved() || busy">Use merged draft</button>
          <button type="button" (click)="merge.set(null); resultPreview.set(null)">Cancel merge</button>
          @if (resultPreview()) { <h3>Merged result</h3><iframe title="Merged result" sandbox="" [srcdoc]="resultPreview()"></iframe> }
        </div>
      }
      @if (error()) { <p role="alert">{{ error() }}</p> }
    </section>`,
  styles: [`:host{display:block}.history{margin:12px 20px;padding:12px;border:1px solid #d8dce7;border-radius:10px;background:#fff;color:#26334b}button{padding:7px 12px;margin:4px;border:1px solid #a6b2ca;border-radius:6px;background:#f6f8fc;cursor:pointer}button[aria-pressed=true]{background:#d8e5ff;border-color:#3869cb}button:disabled{opacity:.5;cursor:default}small{display:block;margin:4px;color:#5b6475}li{margin:8px 0}ol{max-height:280px;overflow:auto}iframe{width:100%;height:330px;background:white;border:1px solid #dce2ec;border-radius:6px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}fieldset{margin:12px 0;border:1px solid #a6b2ca}textarea{display:block;width:95%;min-height:70px}span{margin-left:12px;font-size:13px}@media(max-width:700px){.columns{grid-template-columns:1fr}.history{margin:8px}}`],
})
export class HistoryPanelComponent {
  readonly history = inject(HistoryService);
  private sanitizer = inject(DomSanitizer);
  @Input() busy = false;
  @Output() restore = new EventEmitter<ArrayBuffer>();
  @Output() importRequested = new EventEmitter<File>();
  @Output() merged = new EventEmitter<{ files: Snapshot; other: string }>();
  readonly expanded = signal(false);
  readonly showAutosaves = signal(false);
  readonly inspected = signal<SafeHtml | null>(null);
  readonly proofStatus = signal('');
  readonly error = signal('');
  readonly merge = signal<VisualMerge | null>(null);
  readonly hasAncestor = signal(false);
  readonly oursPreview = signal<SafeHtml | null>(null);
  readonly theirsPreview = signal<SafeHtml | null>(null);
  readonly resultPreview = signal<SafeHtml | null>(null);
  private other = '';
  date(timestamp: number): string { return new Date(timestamp).toLocaleString(); }
  private render(files: Snapshot): SafeHtml { return this.sanitizer.bypassSecurityTrustHtml(preview(files)); }
  async inspect(oid: string): Promise<void> {
    try {
      const files = (await readDocumentArchive(await this.history.snapshot(oid))).files;
      this.inspected.set(this.render(files));
      let count = 0; try { count = JSON.parse(new TextDecoder().decode(files['manifest.json'])).signatures.document.length; } catch { /* Optional manifest. */ }
      this.proofStatus.set(count ? `${count} document proof(s) retained. Open this version in the signature verifier to establish validity and trust.` : 'No document signature on this version.');
    } catch (error) { this.error.set((error as Error).message); }
  }
  async recover(oid: string): Promise<void> { try { this.restore.emit(await this.history.snapshot(oid)); } catch (error) { this.error.set((error as Error).message); } }
  importFile(event: Event): void {
    const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
    if (file) this.importRequested.emit(file);
  }
  async beginMerge(current: ArrayBuffer, incoming: ArrayBuffer): Promise<string | null> {
    try {
      this.error.set(''); const imported = await this.history.import(incoming);
      const ours = (await readDocumentArchive(current)).files;
      this.other = imported.theirs; this.hasAncestor.set(!!imported.base);
      this.merge.set(new VisualMerge(imported.base, ours, imported.incoming));
      this.oursPreview.set(this.render(ours)); this.theirsPreview.set(this.render(imported.incoming)); this.resultPreview.set(null); this.expanded.set(true);
      return imported.theirs;
    } catch (error) { this.error.set((error as Error).message); return null; }
  }
  choose(conflict: VisualConflict, choice: 'ours' | 'theirs'): void { conflict.choice = choice; conflict.text = undefined; this.resultPreview.set(null); }
  canEdit(conflict: VisualConflict): boolean {
    if (conflict.block === undefined) return false;
    const node = new DOMParser().parseFromString(new TextDecoder().decode(conflict.ours), 'text/html').body.firstElementChild;
    return !!node && /^(P|H[1-6]|BLOCKQUOTE|PRE)$/.test(node.tagName) && !node.querySelector('table,form,input,img');
  }
  editText(conflict: VisualConflict, text: string): void { conflict.choice = 'ours'; conflict.text = text; this.resultPreview.set(null); }
  resolved(): boolean { return !!this.merge() && this.merge()!.conflicts.every(conflict => !!conflict.choice); }
  showResult(): void { if (this.merge()) this.resultPreview.set(this.render(this.merge()!.resolve())); }
  apply(): void { if (this.merge()) { this.merged.emit({ files: this.merge()!.resolve(), other: this.other }); this.merge.set(null); this.resultPreview.set(null); } }
}
