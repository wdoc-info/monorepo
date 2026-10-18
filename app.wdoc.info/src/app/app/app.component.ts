import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  AfterViewInit,
  ViewChild,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  NgZone,
} from '@angular/core';
import { WdocSignatureService } from '../signatures/signature.service';
import { encodeLocal } from '../signatures/local-document';
import { HistoryService } from '../history/history.service';
import { HistoryPanelComponent } from '../history/history-panel.component';
import type { Snapshot } from '../history/git-engine';
import { inventory, runtimePath } from '../signatures/core';
import { SignaturePanelComponent } from '../signatures/signature-panel.component';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NavbarComponent } from '../navbar/navbar.component';
import { ViewerComponent } from '../viewer/viewer.component';
import { TopbarComponent } from '../topbar/topbar.component';
import { MatDrawerMode, MatSidenavModule } from '@angular/material/sidenav';
import { FormManagerService } from '../services/form-manager.service';
import { HtmlProcessingService } from '../services/html-processing.service';
import {
  LoadedFile,
  WdocLoadResult,
  WdocLoaderService,
} from '../services/wdoc-loader.service';
import { DialogService } from '../services/dialog.service';
import { DocumentEditorComponent } from '../editor/document-editor.component';
import {
  DocumentAsset,
  DocumentCreatorService,
} from '../services/document-creator.service';
import { EditorAsset } from '../editor/document-editor.component';
import { ExternalFontService } from '../services/external-font.service';
import { LocalFileHandle, LocalFilesService } from '../services/local-files.service';
import { EditedArchiveService } from '../services/edited-archive.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    HistoryPanelComponent,
    SignaturePanelComponent,
    NavbarComponent,
    ViewerComponent,
    TopbarComponent,
    DocumentEditorComponent,
    MatSidenavModule,
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  htmlContent: SafeHtml | null = null;
  showFormSave = false;
  showDocumentSave = false;
  savingRevision = false;
  savingDocument = false;
  openingDocument = false;
  saveError = '';
  includeFonts = false;
  isNavOpen = false;
  isEditing = false;
  sidenavMode: MatDrawerMode = 'over';
  showDropOverlay = false;
  zoom = 100;
  private readonly defaultTitle = 'WDOC viewer';
  private readonly newDocumentTitle = 'New document';
  private readonly minZoom = 25;
  private readonly maxZoom = 200;
  documentTitle = this.defaultTitle;
  editorContent = '<p>Start writing...</p>';
  originalArrayBuffer: ArrayBuffer | null = null;
  private docVersionCounter = 0;
  private loadedDocumentHtml = '';
  private editableContentFromLoaded = '<p>Start writing...</p>';
  private editorAssets: EditorAsset[] = [];
  private loadedAssets: DocumentAsset[] = [];
  private documentEpoch = 0;
  private editVersion = 0;
  private resizeListener?: () => void;
  private isDesktop = false;
  private beforePrintListener?: () => void;
  private afterPrintListener?: () => void;
  private wasNavOpenBeforePrint = false;
  private dragDepth = 0;
  private resizeObserver?: ResizeObserver;
  @ViewChild(HistoryPanelComponent) historyPanel?: HistoryPanelComponent;
  private autosaveTimer?: ReturnType<typeof setInterval>;
  autosaving = false;
  applyingVersion = false;
  private comparisonVersion = -1;
  private autosavedVersion = -1;
  private mergeParent?: string;
  private externalMergeTarget?: { handle: LocalFileHandle; file: File; oid: string };
  private draftSourceBuffer: ArrayBuffer | null = null;
  @ViewChild(ViewerComponent) viewer!: ViewerComponent;

  constructor(
    private sanitizer: DomSanitizer,
    private wdocLoaderService: WdocLoaderService,
    private htmlProcessingService: HtmlProcessingService,
    private formManagerService: FormManagerService,
    private dialogService: DialogService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
    private documentCreatorService: DocumentCreatorService,
    private signatureService: WdocSignatureService,
    public fonts: ExternalFontService,
    public localFiles: LocalFilesService,
    private editedArchive: EditedArchiveService,
    public history: HistoryService,
  ) {}

  attachments: LoadedFile[] = [];
  formAnswers: LoadedFile[] = [];

  ngOnInit(): void {
    void this.history.restoreLastDraft();
    this.zone.runOutsideAngular(() => { this.autosaveTimer = setInterval(() => void this.autosave(), 30_000); });
    if (typeof window !== 'undefined') {
      this.setupFileHandler();
      this.applyResponsiveLayout(window.innerWidth);
      this.resizeListener = () =>
        this.zone.run(() => this.onWindowResize(window.innerWidth));
      window.addEventListener('resize', this.resizeListener);
      this.beforePrintListener = () =>
        this.zone.run(() => {
          this.wasNavOpenBeforePrint = this.isNavOpen;
          this.closeNav();
        });
      window.addEventListener('beforeprint', this.beforePrintListener);
      this.afterPrintListener = () =>
        this.zone.run(() => {
          this.isNavOpen = this.wasNavOpenBeforePrint;
          this.cdr.markForCheck();
        });
      window.addEventListener('afterprint', this.afterPrintListener);
    }
    if (typeof window === 'undefined' || !window.location) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const rawUrl = params.get('url');
    if (!rawUrl) {
      return;
    }

    const trimmedUrl = rawUrl.trim();
    if (!this.isSupportedArchive(trimmedUrl)) {
      return;
    }

    void this.handleLoadedWdoc(
      this.wdocLoaderService.fetchAndLoadWdoc(trimmedUrl)
    );
  }

  ngAfterViewInit(): void {
    const nativeViewer = this.viewer?.nativeElement;
    if (typeof ResizeObserver !== 'undefined' && nativeViewer) {
      this.resizeObserver = new ResizeObserver(() => {
        this.zone.run(() => this.fitContentToViewport());
      });
      this.resizeObserver.observe(nativeViewer);
    }
    this.fitContentToViewport(true);
  }

  ngOnDestroy(): void {
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    this.history.reset();
    if (typeof window !== 'undefined') {
      if (this.resizeListener) {
        window.removeEventListener('resize', this.resizeListener);
      }
      if (this.beforePrintListener) {
        window.removeEventListener('beforeprint', this.beforePrintListener);
      }
      if (this.afterPrintListener) {
        window.removeEventListener('afterprint', this.afterPrintListener);
      }
    }
    if (this.resizeObserver && this.viewer?.nativeElement) {
      this.resizeObserver.unobserve(this.viewer.nativeElement);
      this.resizeObserver.disconnect();
    }
    this.htmlProcessingService.cleanup();
  }

  async onFileSelected(file: File, handle?: LocalFileHandle): Promise<void> {
    if (this.savingDocument || this.savingRevision || this.openingDocument || this.autosaving || this.applyingVersion) return;
    this.openingDocument = true;
    this.saveError = '';
    this.cdr.markForCheck();
    try {
      const opened = await this.handleLoadedWdoc(this.wdocLoaderService.loadWdocFromArrayBuffer(await file.arrayBuffer(), this.defaultTitle));
      if (opened && handle) this.localFiles.attach(handle, file);
    } catch (error) { this.saveError = `The file could not be opened. ${(error as Error).message}`; }
    finally { this.openingDocument = false; this.cdr.markForCheck(); }
  }

  async openLocalFile(handle: LocalFileHandle): Promise<void> {
    try { await this.onFileSelected(await handle.getFile(), handle); }
    catch { this.saveError = 'The local file is unavailable. Refresh the folder or reconnect it.'; this.cdr.markForCheck(); }
  }

  private setupFileHandler() {
    const w = window as any;

    if (!('launchQueue' in window)) {
      // Not supported (non-Chromium or not installed)
      return;
    }

    w.launchQueue.setConsumer(async (launchParams: any) => {
      if (!launchParams.files || !launchParams.files.length) {
        return;
      }

      for (const fileHandle of launchParams.files) {
        await this.openLocalFile(fileHandle);
      }
    });
  }

  toggleNav() {
    this.isNavOpen = !this.isNavOpen;
    this.fitContentToViewport();
  }

  closeNav() {
    this.isNavOpen = false;
    this.fitContentToViewport();
  }

  @HostListener('document:dragenter', ['$event'])
  onDragEnter(event: DragEvent) {
    if (!this.containsFiles(event)) {
      return;
    }
    event.preventDefault();
    this.dragDepth++;
    this.showDropOverlay = true;
  }

  @HostListener('document:dragover', ['$event'])
  onDragOver(event: DragEvent) {
    if (!this.containsFiles(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.showDropOverlay = true;
  }

  @HostListener('document:dragleave', ['$event'])
  onDragLeave(event: DragEvent) {
    if (!this.containsFiles(event)) {
      return;
    }
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.showDropOverlay = false;
    }
  }

  @HostListener('document:drop', ['$event'])
  onDrop(event: DragEvent) {
    if (!this.containsFiles(event)) {
      return;
    }
    event.preventDefault();
    this.dragDepth = 0;
    this.showDropOverlay = false;
    const files = event.dataTransfer?.files;
    if (!files?.length) {
      return;
    }
    const archiveFile = Array.from(files).find((file) =>
      this.isSupportedArchive(file.name)
    );
    if (!archiveFile) {
      this.dialogService.openAlert('Please drop a .wdoc or .zip file.', 'Invalid file');
      return;
    }
    this.onFileSelected(archiveFile);
  }

  onZoomChange(zoom: number) {
    this.zoom = this.clampZoom(zoom);
  }

  async onSaveForms() {
    if (
      !this.originalArrayBuffer ||
      !this.viewer ||
      (!this.viewer.documentRoot && !this.viewer.nativeElement)
    ) {
      return;
    }
    const formRoot = this.viewer.documentRoot ?? this.viewer.nativeElement;
    if (!formRoot) {
      return;
    }
    const saved = await this.formManagerService.saveForms(
      formRoot,
      this.originalArrayBuffer
    );
    if (saved) {
      this.showFormSave = false;
    }
  }

  private containsFiles(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    if (!types) {
      return false;
    }
    return Array.from(types).includes('Files');
  }

  private onWindowResize(width: number) {
    this.applyResponsiveLayout(width);
    this.fitContentToViewport();
    this.cdr.markForCheck();
  }

  private applyResponsiveLayout(width: number) {
    const isDesktop = width >= 992;
    this.sidenavMode = isDesktop ? 'side' : 'over';
    if (isDesktop !== this.isDesktop) {
      this.isDesktop = isDesktop;
      this.isNavOpen = isDesktop;
    }
  }

  private clampZoom(value: number): number {
    const bounded = Math.round(Number.isFinite(value) ? value : this.minZoom);
    return Math.min(this.maxZoom, Math.max(this.minZoom, bounded));
  }

  private fitContentToViewport(force = false) {
    const fitZoom = this.calculateFitZoom();
    if (fitZoom === null) {
      return;
    }
    if (force || this.zoom > fitZoom) {
      this.zoom = fitZoom;
      this.cdr.markForCheck();
    }
  }

  private calculateFitZoom(): number | null {
    if (!this.viewer || !this.viewer.nativeElement) {
      return null;
    }

    const containerWidth = this.viewer.nativeElement.clientWidth;
    if (!containerWidth) {
      return null;
    }

    const root = this.viewer.documentRoot ?? this.viewer.nativeElement;
    const pageElement = (root.querySelector('wdoc-page') ||
      root.firstElementChild) as HTMLElement | null;

    if (!pageElement) {
      return null;
    }

    const baseWidth = pageElement.offsetWidth;
    if (!baseWidth) {
      return null;
    }

    const fitPercent = Math.floor(((containerWidth - 24) / baseWidth) * 100);
    return fitPercent > 100 ? 100 : fitPercent;
  }

  private isSupportedArchive(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith('.wdoc') || lower.endsWith('.zip');
  }

  private async handleLoadedWdoc(
    resultPromise: Promise<WdocLoadResult | null>
  ) {
    const result = await resultPromise;
    if (!result) {
      return false;
    }
    ++this.documentEpoch;
    this.localFiles.detach();
    this.originalArrayBuffer = result.originalArrayBuffer;
    this.autosavedVersion = -1; this.mergeParent = undefined; this.draftSourceBuffer = null; this.externalMergeTarget = undefined;
    void this.history.open(result.originalArrayBuffer);
    this.loadedDocumentHtml = result.html;
    this.editableContentFromLoaded = this.extractEditorContent(result.html);
    this.documentTitle = result.documentTitle;
    this.updateWindowTitle(this.documentTitle);
    this.isEditing = false;
    this.docVersionCounter = 0;
    this.attachments = result.attachments;
    this.formAnswers = result.formAnswers;
    this.showFormSave = false;
    this.showDocumentSave = false;
    this.editorContent = this.editableContentFromLoaded;
    this.editorAssets = [];
    this.loadedAssets = result.assets ?? [];
    this.htmlContent = this.sanitizer.bypassSecurityTrustHtml(result.html);
    if (!this.isDesktop) {
      this.isNavOpen = false;
    }
    this.fitContentToViewport(true);
    this.cdr.markForCheck();
    return true;
  }

  onSignedArchive(buffer: ArrayBuffer): void {
    // Preserve in-progress DOM drafts; immutable signed snapshots live in the archive.
    this.originalArrayBuffer = buffer;
    void this.history.open(buffer);
    this.cdr.markForCheck();
  }

  onFormInteraction(): void {
    this.showFormSave = true;
  }

  startNewDocument(): void {
    if (this.savingDocument || this.savingRevision || this.openingDocument || this.autosaving || this.applyingVersion) return;
    ++this.documentEpoch;
    this.localFiles.detach();
    this.saveError = '';
    this.loadedAssets = [];
    this.fonts.clear();
    this.isEditing = true;
    this.originalArrayBuffer = null;
    this.history.reset(); void this.history.restoreLastDraft(); this.autosavedVersion = -1; this.mergeParent = undefined; this.draftSourceBuffer = null; this.externalMergeTarget = undefined;
    this.documentTitle = this.newDocumentTitle;
    this.updateWindowTitle(this.documentTitle);
    this.editorContent = '<p>Start writing...</p>';
    this.loadedDocumentHtml = '';
    this.editableContentFromLoaded = this.editorContent;
    this.showDocumentSave = true;
    this.showFormSave = false;
    this.docVersionCounter = 0;
    this.editorAssets = [];
    this.cdr.markForCheck();
  }

  startEditingLoadedDocument(): void {
    if (!this.loadedDocumentHtml && !this.htmlContent) {
      return;
    }

    this.isEditing = true;
    this.showDocumentSave = true;
    this.showFormSave = false;
    this.docVersionCounter = 0;
    this.editorContent = this.editableContentFromLoaded;
    this.editorAssets = [];
    this.cdr.markForCheck();
  }

  onDocumentTitleChange(title: string): void {
    ++this.editVersion;
    const normalizedTitle = this.normalizeTitle(title);
    this.documentTitle = normalizedTitle;
    if (this.isEditing) {
      this.showDocumentSave = true;
    }
    this.updateWindowTitle(normalizedTitle);
    this.cdr.markForCheck();
  }

  onIncludeFontsChange(include: boolean): void {
    this.includeFonts = include; ++this.editVersion; this.showDocumentSave = true;
    this.cdr.markForCheck();
  }

  onEditorContentChange(content: string): void {
    ++this.editVersion;
    this.editorContent = content;
    this.editableContentFromLoaded = content;
    this.showDocumentSave = true;
    this.cdr.markForCheck();
  }

  onEditorAssetsChange(assets: EditorAsset[]): void {
    ++this.editVersion;
    this.editorAssets = assets;
    this.showDocumentSave = true;
    this.cdr.markForCheck();
  }

  @HostListener('document:keydown', ['$event'])
  onSaveShortcut(event: KeyboardEvent): void {
    if (this.isEditing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.onSaveNewDocument();
    }
  }

  async onSaveNewDocument(saveAs = false): Promise<void> {
    if (this.savingDocument || this.savingRevision || this.openingDocument || this.autosaving || this.applyingVersion) return;
    this.savingDocument = true;
    this.saveError = '';
    const epoch = this.documentEpoch, editVersion = this.editVersion;
    const content = this.editorContent?.trim()
      ? this.editorContent
      : '<p></p>';
    const docVersion = this.buildNextDocVersion();
    const title = this.documentTitle?.trim()
      ? this.documentTitle.trim()
      : this.newDocumentTitle;
    const filename = `${this.buildFilenameFromTitle(title)}.wdoc`;
    this.cdr.markForCheck();
    try {
      const target = saveAs || this.localFiles.hasLocalTarget() ? await this.localFiles.prepareSave(filename, saveAs) : null;
      if (saveAs && !target) throw new Error('Direct saving is unavailable in this browser. Use Save document to download a copy.');
      if (epoch !== this.documentEpoch) return;
      await this.history.exclusive(async () => {
        const candidate = await this.editedArchive.build({ html: content, version: docVersion, title,
          assets: this.buildDocumentAssets(), includeFonts: this.includeFonts, original: this.draftSourceBuffer ?? this.originalArrayBuffer });
        const buffer = await this.history.publish(await candidate.arrayBuffer(), this.mergeParent);
        const blob = new Blob([buffer], { type: 'application/zip' });
        if (target) {
          const file = await this.localFiles.write(target, blob);
          this.localFiles.attach(target.handle, file); this.localFiles.status.set(`Saved to ${target.handle.name}`);
          await this.localFiles.refresh();
        } else {
          const url = URL.createObjectURL(blob), anchor = document.createElement('a');
          anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        if (epoch === this.documentEpoch) { this.originalArrayBuffer = buffer; this.mergeParent = undefined; this.draftSourceBuffer = null; this.externalMergeTarget = undefined; }
        await this.history.saved();
      });
      if (epoch === this.documentEpoch && editVersion === this.editVersion) this.showDocumentSave = false;
    } catch (error) {
      await this.history.failed().catch(() => undefined);
      if (!this.localFiles.cancelled(error)) this.saveError = `The document was not saved. ${(error as Error).message}`;
    } finally { this.savingDocument = false; this.cdr.markForCheck(); }
  }

  async onSaveSignedRevision(): Promise<void> {
    if (!this.originalArrayBuffer || this.savingRevision || this.savingDocument) return;
    this.savingRevision = true;
    try {
      const target = this.localFiles.activeFile() ? await this.localFiles.prepareSave('signed.wdoc') : null;
      const local = await this.signatureService.read(this.originalArrayBuffer);
      let state = local;
      const blob = new Blob([await this.draftArchive()]);
      const edited = await this.signatureService.read(await blob.arrayBuffer());
      const files = Object.fromEntries(Object.entries(edited.files).filter(([path]) => !runtimePath(path)));
      state = await this.signatureService.operate(state, 'revisions', { files, ...(edited.manifest.content.externalFonts ? { externalFonts: edited.manifest.content.externalFonts } : {}), appVersion: edited.manifest.meta.appVersion, docTitle: this.documentTitle, sign: true });
      const buffer = await this.history.publish(await this.signatureService.archive(state), this.mergeParent);
      const file = target ? await this.localFiles.write(target, new Blob([buffer], { type: 'application/zip' })) : null;
      await this.handleLoadedWdoc(this.wdocLoaderService.loadWdocFromArrayBuffer(buffer));
      if (target && file) { this.localFiles.attach(target.handle, file); this.localFiles.status.set(`Saved to ${target.handle.name}`); await this.localFiles.refresh(); }
      else this.signatureService.download(buffer);
    } catch (e) {
      await this.dialogService.openAlert((e as Error).message, 'Revision could not be signed');
    } finally { this.savingRevision = false; this.cdr.markForCheck(); }
  }

  private async draftArchive(): Promise<ArrayBuffer> {
    return (await this.editedArchive.build({ html: this.editorContent || '<p></p>', title: this.documentTitle,
      version: `${this.docVersionCounter}.0.0`, assets: this.buildDocumentAssets(), includeFonts: this.includeFonts,
      original: this.draftSourceBuffer ?? this.originalArrayBuffer })).arrayBuffer();
  }

  async autosave(): Promise<void> {
    if (!this.isEditing || !this.showDocumentSave || this.savingDocument || this.savingRevision || this.autosaving || this.autosavedVersion === this.editVersion || this.applyingVersion || this.historyPanel?.merge()) return;
    const epoch = this.documentEpoch, version = this.editVersion;
    this.autosaving = true;
    try {
      await this.history.exclusive(async () => {
        const candidate = await this.draftArchive();
        if (epoch !== this.documentEpoch) return;
        await this.history.saveDraft(candidate, this.documentTitle);
        if (!this.originalArrayBuffer) { await this.history.open(candidate); this.originalArrayBuffer = candidate; }
        const buffer = await this.history.autosave(candidate);
        const binding = this.localFiles.activeFile();
        if (binding) {
          if (await binding.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Local write access is paused. The draft is retained in this browser.');
          const file = await this.localFiles.write({ handle: binding.handle, previous: binding }, new Blob([buffer], { type: 'application/zip' }));
          this.localFiles.attach(binding.handle, file);
        }
        if (epoch === this.documentEpoch) { this.originalArrayBuffer = buffer; this.autosavedVersion = version; this.history.status.set('Autosaved · unpublished draft'); }
      });
    } catch (error) { this.history.error.set(`Autosave paused: ${(error as Error).message} Use Merge another version to import external changes, or Save as to keep a copy.`); }
    finally { this.autosaving = false; this.zone.run(() => this.cdr.markForCheck()); }
  }

  async onMergeFile(file: File): Promise<string | null> {
    this.externalMergeTarget = undefined;
    const epoch = this.documentEpoch, version = this.editVersion;
    try {
      const current = this.isEditing ? await this.draftArchive() : this.originalArrayBuffer;
      if (current && epoch === this.documentEpoch) {
        this.comparisonVersion = version;
        return await this.historyPanel?.beginMerge(current, await file.arrayBuffer()) ?? null;
      }
    } catch (error) { this.saveError = (error as Error).message; this.cdr.markForCheck(); }
    return null;
  }

  async mergeChangedLocalFile(): Promise<void> {
    const binding = this.localFiles.activeFile();
    if (!binding) return;
    try {
      const file = await binding.handle.getFile(), oid = await this.onMergeFile(file);
      if (oid) this.externalMergeTarget = { handle: binding.handle, file, oid };
    } catch (error) { this.saveError = (error as Error).message; this.cdr.markForCheck(); }
  }

  async onRestoreDraft(buffer: ArrayBuffer): Promise<void> {
    try {
      if (!this.originalArrayBuffer) {
        if (await this.handleLoadedWdoc(this.wdocLoaderService.loadWdocFromArrayBuffer(buffer))) this.startEditingLoadedDocument();
        return;
      }
      const candidate = await this.signatureService.read(buffer);
      await this.onMergedDraft({ files: this.signatureService.bytes(candidate), other: '' });
    } catch (error) { this.saveError = (error as Error).message; this.cdr.markForCheck(); }
  }

  async onMergedDraft(input: { files: Snapshot; other: string }): Promise<void> {
    if (!this.originalArrayBuffer || this.applyingVersion) return;
    if (input.other && this.comparisonVersion !== this.editVersion) {
      this.saveError = 'Your draft changed after the comparison started. Compare the versions again before applying the result.';
      this.cdr.markForCheck(); return;
    }
    this.applyingVersion = true; this.cdr.markForCheck();
    try {
      const originalBuffer = this.originalArrayBuffer;
      const original = await this.signatureService.read(originalBuffer);
      const files: Record<string, string> = {};
      for (const [path, bytes] of Object.entries(input.files)) if (path !== 'manifest.json' && !runtimePath(path)) files[path] = await encodeLocal(bytes);
      let externalFonts;
      try { externalFonts = JSON.parse(new TextDecoder().decode(input.files['manifest.json'])).content.externalFonts; } catch { /* Optional source metadata. */ }
      const revised = await this.signatureService.reviseUnsigned(original, { files, externalFonts, appVersion: original.manifest.meta.appVersion, docTitle: this.documentTitle });
      for (const path of Object.keys(revised.files)) if (/^(wdoc-form|wdoc-font-cache)\//.test(path)) delete revised.files[path];
      const drafts: Snapshot = {};
      for (const [path, bytes] of Object.entries(input.files)) {
        if (/^(wdoc-form|wdoc-font-cache)\//.test(path)) revised.files[path] = await encodeLocal(bytes);
        if (path.startsWith('wdoc-form/')) drafts[path] = bytes;
      }
      revised.manifest.runtime.forms = Object.keys(drafts).length ? { default: { hashAlgorithm: 'SHA-256', files: await inventory(drafts) } } : {};
      const draftBuffer = await this.signatureService.archive(revised);
      const result = await this.wdocLoaderService.loadWdocFromArrayBuffer(draftBuffer);
      if (!result) throw new Error('The merged draft could not be loaded');
      if (this.externalMergeTarget?.oid === input.other) {
        this.localFiles.attach(this.externalMergeTarget.handle, this.externalMergeTarget.file);
        this.externalMergeTarget = undefined; this.saveError = ''; this.history.error.set('');
      }
      this.draftSourceBuffer = draftBuffer;
      this.loadedAssets = result.assets ?? []; this.editorAssets = [];
      this.editorContent = this.extractEditorContent(result.html); this.editableContentFromLoaded = this.editorContent;
      this.isEditing = true; this.showDocumentSave = true; this.mergeParent = input.other || undefined; ++this.editVersion;
      this.cdr.markForCheck();
    } catch (error) { this.saveError = (error as Error).message; }
    finally { this.applyingVersion = false; this.cdr.markForCheck(); }
  }

  private buildNextDocVersion(): string {
    this.docVersionCounter += 1;
    return `${this.docVersionCounter}.0.0`;
  }

  private extractEditorContent(html: string): string {
    if (!html) {
      return '<p></p>';
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    Array.from(doc.querySelectorAll('style')).forEach((styleEl) =>
      styleEl.remove(),
    );

    const contentBlocks = Array.from(doc.querySelectorAll('wdoc-content'));
    const combined = contentBlocks
      .map((block) => block.innerHTML)
      .join('')
      .trim();

    const fallback = doc.body?.innerHTML?.trim();
    const result = combined || fallback || '<p></p>';
    return result.length > 0 ? result : '<p></p>';
  }

  private buildFilenameFromTitle(title: string): string {
    const safeTitle = title.trim() || 'document';
    const slug = safeTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'document';
  }

  private normalizeTitle(title: string): string {
    const normalized = title.trim();
    return normalized.length > 0 ? normalized : this.newDocumentTitle;
  }

  private buildDocumentAssets(): DocumentAsset[] {
    return [...this.loadedAssets, ...this.editorAssets.map((asset) => ({
      path: asset.path,
      file: asset.file,
      objectUrl: asset.objectUrl,
    }))];
  }

  private updateWindowTitle(title: string): void {
    if (typeof document === 'undefined') {
      return;
    }
    document.title = title;
  }
}
