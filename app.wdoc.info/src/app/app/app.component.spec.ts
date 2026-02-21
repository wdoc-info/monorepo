import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { AppComponent } from './app.component';
import { FormManagerService } from '../services/form-manager.service';
import { HtmlProcessingService } from '../services/html-processing.service';
import { WdocLoaderService } from '../services/wdoc-loader.service';
import { DialogService } from '../services/dialog.service';
import { DocumentCreatorService } from '../services/document-creator.service';

describe('AppComponent', () => {
  let formManager: jasmine.SpyObj<FormManagerService>;
  let wdocLoader: jasmine.SpyObj<WdocLoaderService>;
  let htmlProcessor: jasmine.SpyObj<HtmlProcessingService>;
  let dialogService: jasmine.SpyObj<DialogService>;
  let documentCreator: jasmine.SpyObj<DocumentCreatorService>;

  beforeEach(async () => {
    formManager = jasmine.createSpyObj('FormManagerService', ['saveForms']);
    wdocLoader = jasmine.createSpyObj('WdocLoaderService', [
      'fetchAndLoadWdoc',
    ]);
    htmlProcessor = jasmine.createSpyObj('HtmlProcessingService', ['cleanup']);
    dialogService = jasmine.createSpyObj('DialogService', ['openAlert']);
    dialogService.openAlert.and.resolveTo();
    documentCreator = jasmine.createSpyObj('DocumentCreatorService', [
      'downloadWdocFromHtml',
    ]);

    await TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, AppComponent],
      providers: [
        { provide: FormManagerService, useValue: formManager },
        { provide: WdocLoaderService, useValue: wdocLoader },
        { provide: HtmlProcessingService, useValue: htmlProcessor },
        { provide: DialogService, useValue: dialogService },
        { provide: DocumentCreatorService, useValue: documentCreator },
      ],
    }).compileComponents();
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
    expect(documentCreator.downloadWdocFromHtml).toHaveBeenCalledWith(
      jasmine.any(String),
      '1.0.0',
      'New document',
      'new-document.wdoc',
      [],
    );
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

    expect(documentCreator.downloadWdocFromHtml).toHaveBeenCalledWith(
      jasmine.any(String),
      '2.0.0',
      'New document',
      'new-document.wdoc',
      [],
    );
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
