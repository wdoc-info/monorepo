import { TestBed } from '@angular/core/testing';
import JSZip from 'jszip';
import { APP_VERSION } from '../config/app.config';
import { AuthService } from './auth.service';
import {
  DocumentAsset,
  DocumentCreatorService,
} from './document-creator.service';
import { WdocManifest } from './manifest-builder';

describe('DocumentCreatorService', () => {
  let service: DocumentCreatorService;
  let authService: jasmine.SpyObj<AuthService>;

  beforeEach(() => {
    authService = jasmine.createSpyObj<AuthService>('AuthService', [
      'getCurrentUserEmail',
    ]);
    authService.getCurrentUserEmail.and.returnValue('author@example.com');

    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: authService }],
    });
    service = TestBed.inject(DocumentCreatorService);
  });

  it('builds a wdoc blob with an index and manifest entries', async () => {
    const blob = await service.buildWdocBlob(
      '<p>Draft</p>',
      '1.0.0',
      'Draft Document',
    );
    const arrayBuffer = await blob.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const index = zip.file('index.html');
    const manifest = zip.file('manifest.json');

    expect(index).toBeTruthy();
    expect(manifest).toBeTruthy();

    const manifestJson = JSON.parse(
      await manifest!.async('text'),
    ) as WdocManifest;
    expect(manifestJson.content.files['index.html']).toBeDefined();
    expect(manifestJson.content.hashAlgorithm).toBe('sha256');
    expect(manifestJson.meta.appVersion).toBe(APP_VERSION);
    expect(manifestJson.meta.creator).toBe('author@example.com');
    expect(manifestJson.meta.docTitle).toBe('Draft Document');
    expect(manifestJson.meta.docVersion).toBe('1.0.0');
  });

  it('scopes default styles to the document wrapper', async () => {
    const blob = await service.buildWdocBlob(
      '<p>Draft</p>',
      '1.0.0',
      'Draft Document',
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const indexContent = await zip.file('index.html')!.async('text');

    expect(indexContent).toContain('class="wdoc-document"');
    expect(indexContent).toContain('.wdoc-document h1');
    expect(indexContent.includes('body {')).toBeFalse();
  });

  it('downloads a wdoc with the provided filename', async () => {
    const createObjectUrlSpy = spyOn(URL, 'createObjectURL').and.returnValue('blob:url');
    const revokeSpy = spyOn(URL, 'revokeObjectURL');
    const clickSpy = spyOn(HTMLAnchorElement.prototype, 'click');

    await service.downloadWdocFromHtml(
      '<p>content</p>',
      '2.0.0',
      'Custom Title',
      'custom-name.wdoc',
      [],
    );

    expect(createObjectUrlSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalledWith('blob:url');
  });

  it('derives the filename from the title when none is provided', async () => {
    const createObjectUrlSpy = spyOn(URL, 'createObjectURL').and.returnValue('blob:url2');
    spyOn(URL, 'revokeObjectURL');
    let anchor: HTMLAnchorElement | null = null;
    const realCreateElement = document.createElement.bind(document);
    spyOn(document, 'createElement').and.callFake((tag: string) => {
      if (tag === 'a') {
        anchor = realCreateElement(tag) as HTMLAnchorElement;
        spyOn(anchor, 'click');
        return anchor;
      }
      return realCreateElement(tag);
    });

    await service.downloadWdocFromHtml('<p>content</p>', '1.2.3', 'Fancy Title');

    expect(createObjectUrlSpy).toHaveBeenCalled();
    expect(anchor).toBeTruthy();
    expect(anchor!.download).toBe('fancy-title.wdoc');
    expect(anchor!.click).toHaveBeenCalled();
  });

  it('stores assets under wdoc-assets and rewrites image sources', async () => {
    const assets: DocumentAsset[] = [
      {
        path: 'wdoc-assets/photo.png',
        file: new Blob(['image-bytes'], { type: 'image/png' }),
        objectUrl: 'blob:photo',
      },
    ];

    const blob = await service.buildWdocBlob(
      '<p><img src="blob:photo" data-asset-src="wdoc-assets/photo.png" /></p>',
      '1.0.0',
      'Photo Doc',
      assets,
    );

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const assetFile = zip.file('wdoc-assets/photo.png');
    const indexContent = await zip.file('index.html')!.async('text');

    expect(assetFile).toBeTruthy();
    expect(indexContent).toContain('src="wdoc-assets/photo.png"');
  });

  it('includes all document files in manifest content and runtime sections', async () => {
    const zip = new JSZip();
    zip.file('index.html', '<p>hello</p>');
    zip.folder('wdoc-form')?.file('form-1.json', '{}');
    zip.file('assets/image.png', 'data');

    const manifestJson = JSON.parse(
      await (service as any).generateManifest(zip, '1.0.0', 'Loaded document'),
    ) as WdocManifest;

    expect(manifestJson.content.files['index.html']).toBeDefined();
    expect(manifestJson.content.files['assets/image.png']).toBeDefined();
    expect(
      manifestJson.runtime.forms['default'].files['wdoc-form/form-1.json'],
    ).toBeDefined();
  });

  it('omits creator when no user session is available', async () => {
    authService.getCurrentUserEmail.and.returnValue(null);

    const blob = await service.buildWdocBlob(
      '<p>Draft</p>',
      '1.0.0',
      'Draft Document',
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifestJson = JSON.parse(
      await zip.file('manifest.json')!.async('text'),
    ) as WdocManifest;

    expect(manifestJson.meta.creator).toBeUndefined();
    expect(manifestJson.meta.appVersion).toBe(APP_VERSION);
    expect(manifestJson.meta.docVersion).toBe('1.0.0');
  });
});
