import { signal } from '@angular/core';
import { HistoryService } from '../history/history.service';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { AppComponent } from './app.component';
import { FormManagerService } from '../services/form-manager.service';
import { HtmlProcessingService } from '../services/html-processing.service';
import { WdocLoaderService } from '../services/wdoc-loader.service';
import { DialogService } from '../services/dialog.service';
import { DocumentCreatorService } from '../services/document-creator.service';
import { FILE_SYSTEM_ACCESS, LocalFileHandle, LocalFilesService } from '../services/local-files.service';
import { EditedArchiveService } from '../services/edited-archive.service';

describe('AppComponent', () => {
  let formManager: jasmine.SpyObj<FormManagerService>;
  let wdocLoader: jasmine.SpyObj<WdocLoaderService>;
  let htmlProcessor: jasmine.SpyObj<HtmlProcessingService>;
  let dialogService: jasmine.SpyObj<DialogService>;
  let documentCreator: jasmine.SpyObj<DocumentCreatorService>;
  let editedArchive: jasmine.SpyObj<EditedArchiveService>;
  let localFiles: LocalFilesService;

  beforeEach(async () => {
    formManager = jasmine.createSpyObj('FormManagerService', ['saveForms']);
    wdocLoader = jasmine.createSpyObj('WdocLoaderService', [
      'fetchAndLoadWdoc',
      'loadWdocFromArrayBuffer',
    ]);
    htmlProcessor = jasmine.createSpyObj('HtmlProcessingService', ['cleanup']);
    dialogService = jasmine.createSpyObj('DialogService', ['openAlert']);
    dialogService.openAlert.and.resolveTo();
    documentCreator = jasmine.createSpyObj('DocumentCreatorService', [
      'downloadWdocFromHtml',
    ]);
    editedArchive = jasmine.createSpyObj('EditedArchiveService', ['build']);
    editedArchive.build.and.resolveTo(new Blob(['saved archive']));
    const history = { entries: signal([]), error: signal(''), status: signal(''), recovery: signal(null),
      restoreLastDraft: jasmine.createSpy().and.resolveTo(), reset: jasmine.createSpy(), open: jasmine.createSpy().and.resolveTo(),
      exclusive: async (run: () => Promise<unknown>) => run(), publish: async (buffer: ArrayBuffer) => buffer,
      failed: jasmine.createSpy().and.resolveTo(), saved: jasmine.createSpy().and.resolveTo() };

    await TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, AppComponent],
      providers: [
        { provide: HistoryService, useValue: history },
        { provide: FormManagerService, useValue: formManager },
        { provide: WdocLoaderService, useValue: wdocLoader },
        { provide: HtmlProcessingService, useValue: htmlProcessor },
        { provide: DialogService, useValue: dialogService },
        { provide: DocumentCreatorService, useValue: documentCreator },
        { provide: EditedArchiveService, useValue: editedArchive },
        { provide: FILE_SYSTEM_ACCESS, useValue: {} },
      ],
    }).compileComponents();
    localFiles = TestBed.inject(LocalFilesService);
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should mark showFormSave when form input changes', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    app.onFormInteraction();
    expect(app.showFormSave).toBeTrue();
  });

  it('clamps zoom changes within bounds', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;

    app.onZoomChange(10);
    expect(app.zoom).toBe(25);

    app.onZoomChange(199.6);
    expect(app.zoom).toBe(200);

    app.onZoomChange(Number.NaN);
    expect(app.zoom).toBe(25);
  });

  it('fits content to the viewport when zoom exceeds fit value', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 400 });
    const page = document.createElement('wdoc-page');
    Object.defineProperty(page, 'offsetWidth', { value: 500 });
    container.appendChild(page);
    app.viewer = { nativeElement: container } as any;

    app.zoom = 150;
    app['fitContentToViewport']();
    expect(app.zoom).toBe(75);

    app.zoom = 60;
    app['fitContentToViewport']();
    expect(app.zoom).toBe(60);

    app.zoom = 150;
    app['fitContentToViewport'](true);
    expect(app.zoom).toBe(75);
  });

  it('adjusts layout responsively when crossing the desktop threshold', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;

    app.isNavOpen = false;
    app['applyResponsiveLayout'](500);
    expect(app.sidenavMode).toBe('over');
    expect(app.isNavOpen).toBeFalse();

    app.isNavOpen = false;
    app['applyResponsiveLayout'](1200);
    expect(app.sidenavMode).toBe('side');
    expect(app.isNavOpen).toBeTrue();
  });

  it('toggles navigation and handles window resize', fakeAsync(() => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    const fitSpy = spyOn(app, 'fitContentToViewport');

    app.isNavOpen = false;
    app.toggleNav();
    expect(app.isNavOpen).toBeTrue();
    expect(fitSpy).toHaveBeenCalled();

    fitSpy.calls.reset();
    app.closeNav();
    expect(app.isNavOpen).toBeFalse();
    expect(fitSpy).toHaveBeenCalled();
  }));

  it('ignores drop events without supported files', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    (app as any).dragDepth = 2;
    app.showDropOverlay = true;

    const dataTransfer = {
      types: ['Files'],
      files: [new File(['text'], 'notes.txt')] as any,
    } as unknown as DataTransfer;

    app.onDrop({ preventDefault() {}, dataTransfer } as DragEvent);

    expect((app as any).dragDepth).toBe(0);
    expect(app.showDropOverlay).toBeFalse();
  });

  it('detects when drag events contain files', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;

    expect((app as any).containsFiles({} as unknown as DragEvent)).toBeFalse();
    expect(
      (app as any).containsFiles({
        dataTransfer: { types: ['Files'] },
      } as unknown as DragEvent)
    ).toBeTrue();
  });

  it('calls saveForms when saving and resets showFormSave', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    const buffer = new ArrayBuffer(8);
    (app as any).originalArrayBuffer = buffer;
    const container = document.createElement('div');
    (app as any).viewer = { nativeElement: container } as any;
    formManager.saveForms.and.resolveTo(true);

    await app.onSaveForms();

    expect(formManager.saveForms).toHaveBeenCalledWith(container, buffer);
    expect(app.showFormSave).toBeFalse();
  });

  it('creates a new document and triggers a download on save', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    app.startNewDocument();
    await app.onSaveNewDocument();

    expect(app.isEditing).toBeTrue();
    expect(editedArchive.build).toHaveBeenCalledWith(jasmine.objectContaining({ version: '1.0.0', title: 'New document', html: jasmine.any(String) }));
    expect(app.originalArrayBuffer).toBeTruthy();
  });

  it('normalizes an empty title and marks the document dirty while editing', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    app.isEditing = true;
    app.onDocumentTitleChange('   ');

    expect(app.documentTitle).toBe('New document');
    expect(app.showDocumentSave).toBeTrue();
    expect(document.title).toBe('New document');
  });

  it('extracts editor content from wdoc pages', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    const html = `<!doctype html>
      <html><body>
        <wdoc-container>
          <wdoc-page><wdoc-content><p>First</p></wdoc-content></wdoc-page>
          <wdoc-page><wdoc-content><p>Second</p></wdoc-content></wdoc-page>
        </wdoc-container>
      </body></html>`;

    const content = app['extractEditorContent'](html);

    expect(content).toContain('First');
    expect(content).toContain('Second');
  });

  it('enters editing mode with previously loaded content', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    app['loadedDocumentHtml'] = '<wdoc-container><wdoc-content><p>Loaded</p></wdoc-content></wdoc-container>';
    app['editableContentFromLoaded'] = '<p>Loaded</p>';

    app.startEditingLoadedDocument();

    expect(app.isEditing).toBeTrue();
    expect(app.editorContent).toContain('Loaded');
    expect(app.showDocumentSave).toBeTrue();
  });

  it('bumps document version on each subsequent save', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    app.startNewDocument();

    await app.onSaveNewDocument();
    await app.onSaveNewDocument();

    expect(editedArchive.build).toHaveBeenCalledWith(jasmine.objectContaining({ version: '2.0.0', title: 'New document' }));
  });

  const localHandle = (): LocalFileHandle => ({ kind: 'file', name: 'report.wdoc',
    getFile: async () => new File(['original'], 'report.wdoc', { lastModified: 1 }),
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
  });

  it('saves a linked file directly and clears dirty state only after the write completes', async () => {
    const app = TestBed.createComponent(AppComponent).componentInstance;
    app.startNewDocument(); app.onEditorContentChange('<p>Local edits</p>');
    const handle = localHandle(); localFiles.attach(handle, await handle.getFile());
    let finish!: (file: File) => void;
    const write = spyOn(localFiles, 'write').and.returnValue(new Promise(resolve => finish = resolve));
    const saving = app.onSaveNewDocument();
    for (let n = 0; n < 20 && !write.calls.count(); n++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(write).toHaveBeenCalled(); expect(app.savingDocument).toBeTrue(); expect(app.showDocumentSave).toBeTrue();
    await app.onSaveNewDocument(); expect(write).toHaveBeenCalledTimes(1);
    finish(new File(['saved archive'], 'report.wdoc', { lastModified: 2 })); await saving;
    expect(app.savingDocument).toBeFalse(); expect(app.showDocumentSave).toBeFalse();
    expect(localFiles.activeFile()?.lastModified).toBe(2);
    expect(documentCreator.downloadWdocFromHtml).not.toHaveBeenCalled();
  });

  it('keeps newer editor changes dirty while committing an earlier save', async () => {
    const app = TestBed.createComponent(AppComponent).componentInstance;
    app.startNewDocument(); const handle = localHandle(); localFiles.attach(handle, await handle.getFile());
    let finish!: (file: File) => void;
    spyOn(localFiles, 'write').and.returnValue(new Promise(resolve => finish = resolve));
    const saving = app.onSaveNewDocument(); await new Promise(resolve => setTimeout(resolve, 0));
    app.onEditorContentChange('<p>Newer changes</p>');
    finish(new File(['saved archive'], 'report.wdoc', { lastModified: 2 })); await saving;
    expect(app.showDocumentSave).toBeTrue(); expect(app.editorContent).toContain('Newer changes');
  });

  it('keeps the original file link and unsaved changes when writing fails', async () => {
    const app = TestBed.createComponent(AppComponent).componentInstance;
    app.startNewDocument(); const handle = localHandle(); localFiles.attach(handle, await handle.getFile());
    const baseline = localFiles.activeFile(); spyOn(localFiles, 'write').and.rejectWith(new Error('Disk full'));
    await app.onSaveNewDocument();
    expect(app.showDocumentSave).toBeTrue(); expect(app.saveError).toContain('Disk full');
    expect(localFiles.activeFile()).toBe(baseline); expect(app.savingDocument).toBeFalse();
    expect(documentCreator.downloadWdocFromHtml).not.toHaveBeenCalled();
  });

  it('retains the draft without an error when a Save as picker is cancelled', async () => {
    const app = TestBed.createComponent(AppComponent).componentInstance; app.startNewDocument();
    spyOn(localFiles, 'prepareSave').and.rejectWith(new DOMException('Cancelled', 'AbortError'));
    await app.onSaveNewDocument(true);
    expect(app.showDocumentSave).toBeTrue(); expect(app.saveError).toBe(''); expect(app.savingDocument).toBeFalse();
    expect(editedArchive.build).not.toHaveBeenCalled();
  });

  it('links a local handle only after a document loads successfully and clears it for a new document', async () => {
    const app = TestBed.createComponent(AppComponent).componentInstance;
    const previous = localHandle(); localFiles.attach(previous, await previous.getFile());
    const incoming = { ...localHandle(), name: 'incoming.wdoc' };
    wdocLoader.loadWdocFromArrayBuffer.and.resolveTo(null);
    await app.openLocalFile(incoming); expect(localFiles.activeFile()?.handle).toBe(previous);
    wdocLoader.loadWdocFromArrayBuffer.and.resolveTo({ html: '<p>Incoming</p>', documentTitle: 'Incoming', originalArrayBuffer: new ArrayBuffer(0), attachments: [], formAnswers: [] });
    await app.openLocalFile(incoming); expect(localFiles.activeFile()?.handle).toBe(incoming);
    app.startNewDocument(); expect(localFiles.activeFile()).toBeNull();
  });

  it('handles dragenter/leave to toggle overlay depth', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance as any;
    const eventBase = {
      preventDefault() {},
      dataTransfer: { types: ['Files'] },
    } as unknown as DragEvent;

    app.onDragEnter(eventBase);
    expect((app as any).dragDepth).toBe(1);
    expect(app.showDropOverlay).toBeTrue();

    app.onDragLeave(eventBase);
    expect((app as any).dragDepth).toBe(0);
    expect(app.showDropOverlay).toBeFalse();
  });
});
