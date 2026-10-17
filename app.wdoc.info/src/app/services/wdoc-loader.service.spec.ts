import { generateManifest } from './manifest-builder';
import { TestBed } from '@angular/core/testing';
import {
  HttpClientTestingModule,
  HttpTestingController,
} from '@angular/common/http/testing';
import JSZip from 'jszip';
import { HtmlProcessingService } from './html-processing.service';
import { WdocLoaderService } from './wdoc-loader.service';
import { DialogService } from './dialog.service';

describe('WdocLoaderService', () => {
  let service: WdocLoaderService;
  let httpMock: HttpTestingController;
  let htmlProcessor: jasmine.SpyObj<HtmlProcessingService>;
  let dialogService: jasmine.SpyObj<DialogService>;

  beforeEach(() => {
    htmlProcessor = jasmine.createSpyObj('HtmlProcessingService', [
      'processHtml',
    ]);
    dialogService = jasmine.createSpyObj('DialogService', [
      'openAlert',
      'openLoading',
    ]);
    dialogService.openAlert.and.resolveTo();
    dialogService.openLoading.and.returnValue(jasmine.createSpy('closeLoading'));
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        { provide: HtmlProcessingService, useValue: htmlProcessor },
        { provide: DialogService, useValue: dialogService },
      ],
    });
    service = TestBed.inject(WdocLoaderService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('accepts a ZIP containing only index.html as an unsigned document', async () => {
    const zip = new JSZip(); zip.file('index.html', '<p>Unsigned</p>');
    htmlProcessor.processHtml.and.resolveTo({ html: '<p>Unsigned</p>', documentTitle: 'Document' });
    expect(await service.loadWdocFromArrayBuffer(await zip.generateAsync({type:'arraybuffer'}))).not.toBeNull();
    expect(dialogService.openAlert).not.toHaveBeenCalled();
  });

  it('verifies manifest entries and blocks mismatches at either document root', async () => {
    for (const prefix of ['', 'Report/']) {
      const source = new JSZip(); source.file('index.html', '<p>Original</p>');
      const manifest = await generateManifest(source);
      const zip = new JSZip();
      zip.file(`${prefix}index.html`, '<p>Modified</p>'); zip.file(`${prefix}manifest.json`, JSON.stringify(manifest));
      expect(await service.loadWdocFromArrayBuffer(await zip.generateAsync({type:'arraybuffer'}))).toBeNull();
    }
    expect(htmlProcessor.processHtml).not.toHaveBeenCalled();
    expect(dialogService.openAlert).toHaveBeenCalledWith('The document content does not match its manifest and will not be opened.', 'Verification failed');
  });

  it('loads nested index files within the zip archive', async () => {
    const zip = new JSZip();
    zip.folder('docs')!.file('index.html', '<html><body>Nested</body></html>');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    htmlProcessor.processHtml.and.resolveTo({
      html: '<body>processed</body>',
      documentTitle: 'Doc',
    });

    const result = await service.loadWdocFromArrayBuffer(buffer, 'WDOC viewer');

    expect(htmlProcessor.processHtml).toHaveBeenCalled();
    expect(result?.html).toContain('processed');
    expect(result?.attachments.length).toBe(0);
    expect(result?.formAnswers.length).toBe(0);
    expect(htmlProcessor.processHtml).toHaveBeenCalledWith(
      jasmine.anything(),
      '<html><body>Nested</body></html>',
      { defaultTitle: 'WDOC viewer', basePath: '' },
    );
  });

  it('finds attachments alongside a nested index file', async () => {
    const zip = new JSZip();
    zip.folder('report')!.file('index.html', '<html><body>Nested</body></html>');
    zip.folder('report/wdoc-attachment')!.file('photo.jpg', 'image-bytes');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    htmlProcessor.processHtml.and.resolveTo({ html: '<body>processed</body>', documentTitle: 'Doc' });

    const result = await service.loadWdocFromArrayBuffer(buffer);

    expect(result?.attachments.map((file) => file.name)).toEqual(['photo.jpg']);
  });

  it('rejects a second root folder even when it contains OS metadata', async () => {
    const zip = new JSZip();
    zip.file('__MACOSX/._longtable', 'metadata');
    zip.folder('longtable')!.file('index.html', '<html><body>Nested</body></html>');
    zip.file('__MACOSX/longtable/._index.html', 'metadata');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    htmlProcessor.processHtml.and.resolveTo({
      html: '<body>processed</body>',
      documentTitle: 'Doc',
    });

    const result = await service.loadWdocFromArrayBuffer(buffer, 'WDOC viewer');

    expect(result).toBeNull();
    expect(htmlProcessor.processHtml).not.toHaveBeenCalled();
    expect(dialogService.openAlert).toHaveBeenCalledWith(jasmine.any(String), 'Invalid archive layout');
  });

  it('alerts when no index file is present', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'info');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    htmlProcessor.processHtml.and.resolveTo({ html: '', documentTitle: '' });

    const result = await service.loadWdocFromArrayBuffer(buffer);

    expect(result).toBeNull();
    expect(dialogService.openAlert).toHaveBeenCalledWith(
      jasmine.any(String),
      'Invalid archive layout',
    );
  });

  it('collects attachment and form answer files from the archive', async () => {
    const zip = new JSZip();
    const attachments = zip.folder('wdoc-attachment');
    attachments?.file('guide.pdf', 'pdf-data');
    const forms = zip.folder('wdoc-form');
    forms?.file('form-1.json', '{"name":"Test"}');
    forms?.file('image.png', 'image-bytes');
    zip.file('index.html', '<html><body>Doc</body></html>');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });

    htmlProcessor.processHtml.and.resolveTo({
      html: '<body>processed</body>',
      documentTitle: 'Doc',
    });

    const result = await service.loadWdocFromArrayBuffer(buffer);

    expect(result?.attachments.map((f) => f.name)).toContain('guide.pdf');
    expect(result?.formAnswers.map((f) => f.name)).toContain('form-1.json');
    expect(result?.formAnswers.map((f) => f.name)).toContain('image.png');
  });

  it('ignores OS metadata files in attachment and form folders', async () => {
    const zip = new JSZip();
    const attachments = zip.folder('wdoc-attachment');
    attachments?.file('guide.pdf', 'pdf-data');
    attachments?.file('.DS_Store', 'mac');
    attachments?.file('__MACOSX/._guide.pdf', 'macos');
    const forms = zip.folder('wdoc-form');
    forms?.file('Thumbs.db', 'windows');
    forms?.file('answer.json', '{"ok":true}');
    zip.file('index.html', '<html><body>Doc</body></html>');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });

    htmlProcessor.processHtml.and.resolveTo({
      html: '<body>processed</body>',
      documentTitle: 'Doc',
    });

    const result = await service.loadWdocFromArrayBuffer(buffer);

    expect(result?.attachments.map((f) => f.name)).toEqual(['guide.pdf']);
    expect(result?.formAnswers.map((f) => f.name)).toEqual(['answer.json']);
  });

  it('guesses common mime types and falls back for unknown', () => {
    const guessMime = (service as any).guessMimeType.bind(service);

    expect(guessMime('file.pdf')).toBe('application/pdf');
    expect(guessMime('file.jpeg')).toBe('image/jpeg');
    expect(guessMime('file.jpg')).toBe('image/jpeg');
    expect(guessMime('file.png')).toBe('image/png');
    expect(guessMime('file.gif')).toBe('image/gif');
    expect(guessMime('file.json')).toBe('application/json');
    expect(guessMime('file.css')).toBe('text/css');
    expect(guessMime('file.js')).toBe('application/javascript');
    expect(guessMime('file.txt')).toBe('text/plain');
    expect(guessMime('file.unknown')).toBeUndefined();
  });

  it('rejects unsupported or missing manifest versions', async () => {
    const zip=new JSZip();zip.file('index.html','<p>Document</p>');
    for (const value of [{manifestVersion:'2.0'}, {meta:{},content:{},runtime:{}}]) {
      zip.file('manifest.json', JSON.stringify(value));
      expect(await service.loadWdocFromArrayBuffer(await zip.generateAsync({type:'arraybuffer'}))).toBeNull();
    }
    expect(htmlProcessor.processHtml).not.toHaveBeenCalled();
    expect(dialogService.openAlert).toHaveBeenCalledWith('The document manifest uses an unsupported format and will not be opened.','Unsupported manifest');
  });

  it('rejects ambiguous and deeply nested entry points', async () => {
    for (const paths of [['one/index.html','two/index.html'], ['one/index.html','two/'], ['one/index.html','readme.txt'], ['one/nested/index.html'], ['INDEX.HTML'], ['one/Index.html']]) {
      const zip = new JSZip(); for (const path of paths) zip.file(path, path.endsWith('/') ? '' : '<p>Document</p>', {dir:path.endsWith('/'),createFolders:false});
      expect(await service.loadWdocFromArrayBuffer(await zip.generateAsync({type:'arraybuffer'}))).withContext(paths.join(',')).toBeNull();
    }
    expect(htmlProcessor.processHtml).not.toHaveBeenCalled();
  });

  it('keeps root index.html authoritative with multiple resource folders', async () => {
    const zip = new JSZip(); zip.file('index.html','<p>Root</p>');zip.file('images/logo.png','image');zip.file('styles/main.css','body{}');zip.file('resources/index.html','<p>Resource</p>');
    htmlProcessor.processHtml.and.resolveTo({html:'<p>Root</p>',documentTitle:'Root'});
    expect(await service.loadWdocFromArrayBuffer(await zip.generateAsync({type:'arraybuffer'}))).not.toBeNull();
    expect(htmlProcessor.processHtml).toHaveBeenCalledWith(jasmine.anything(), '<p>Root</p>', {defaultTitle:'WDOC viewer',basePath:''});
  });

  it('rejects malformed UTF-8 in an entry point or manifest before rendering', async () => {
    const invalid=new Uint8Array([0xc3,0x28]);
    for (const path of ['index.html','manifest.json']) {
      const zip=new JSZip();zip.file('index.html','<p>Document</p>');zip.file(path,invalid);
      expect(await service.loadWdocFromArrayBuffer(await zip.generateAsync({type:'arraybuffer'}))).toBeNull();
    }
    expect(htmlProcessor.processHtml).not.toHaveBeenCalled();
  });
});
