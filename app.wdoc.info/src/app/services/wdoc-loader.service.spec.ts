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

  it('computes SHA-256 hashes', async () => {
    const data = new TextEncoder().encode('hello');
    const sha = await WdocLoaderService.computeSha256(data);
    expect(sha).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('verifies manifest entries and blocks mismatches', async () => {
    const zip = new JSZip();
    zip.file('index.html', '<html></html>');
    zip.file(
      'manifest.json',
      JSON.stringify({
        meta: {
          docTitle: 'Doc',
          creator: 'tester',
          creationDate: '2024-01-01T00:00:00Z',
          lastUpdateDate: '2024-01-01T00:00:00Z',
        },
        content: {
          hashAlgorithm: 'sha256',
          lastUpdateDate: '2024-01-01T00:00:00Z',
          files: { 'index.html': '0'.repeat(64) },
          contentDigest: '0'.repeat(64),
        },
        runtime: { forms: {} },
      })
    );
    const ok = await (service as any).verifyContentManifest(zip);
    expect(ok).toBeFalse();
    expect(dialogService.openAlert).toHaveBeenCalledWith(
      'The document content does not match its manifest and will not be opened.',
      'Verification failed',
    );
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
  });

  it('alerts when no index file is present', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'info');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    htmlProcessor.processHtml.and.resolveTo({ html: '', documentTitle: '' });

    const result = await service.loadWdocFromArrayBuffer(buffer);

    expect(result).toBeNull();
    expect(dialogService.openAlert).toHaveBeenCalledWith(
      'index.html not found in the archive.',
      'Missing entry',
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
});
