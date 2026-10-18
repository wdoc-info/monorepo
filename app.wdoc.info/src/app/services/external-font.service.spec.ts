import { TestBed } from '@angular/core/testing';
import { ExternalFontService } from './external-font.service';
import { FontTrustService } from './font-trust.service';
import { decodeUtf8, encoder, sha256, type Files } from '../signatures/core';

describe('External font preparation', () => {
  let service: ExternalFontService; let fetcher: jasmine.Spy; let trust: jasmine.SpyObj<FontTrustService>;
  const url = 'https://fonts.example.test/regular.woff2';
  const bytes = encoder.encode('wOF2 fake font bytes for mocked decoder');
  const source = (css = `@font-face{font-family:Example;font-weight:400;src:url("${url}")} p{font-family:Example}`): Files => ({ 'index.html': encoder.encode(`<html><head><style>${css}</style></head><body><p>Text</p></body></html>`) });
  beforeEach(() => {
    trust = jasmine.createSpyObj('FontTrustService', ['authorize', 'permitted']); trust.authorize.and.resolveTo(); trust.permitted.and.returnValue(true);
    TestBed.configureTestingModule({ providers: [{ provide: FontTrustService, useValue: trust }] }); service = TestBed.inject(ExternalFontService);
    fetcher = spyOn(window, 'fetch').and.callFake(async () => new Response(new Uint8Array(bytes)));
    spyOn(window, 'FontFace').and.callFake((function (family: string) { return { family, load: () => Promise.resolve(), status: 'loaded' }; }) as any);
    spyOn(document.fonts, 'add'); spyOn(document.fonts, 'delete');
  });
  afterEach(async () => { service.clear(); await caches.delete('wdoc-font-bytes-v1'); });
  it('pins downloaded bytes, removes local substitution, and changes only normalized source', async () => {
    const original = source(`@font-face{font-family:Example;src:local(Example),url("${url}")} p{font-family:Example}`);
    const result = await service.prepare(original, 'pin');
    expect(result.externalFonts[url]).toBe(await sha256(bytes)); expect(decodeUtf8(result.files['index.html'])).not.toContain('local(');
    expect(decodeUtf8(original['index.html'])).toContain('local(');
    expect(fetcher.calls.mostRecent().args[1]).toEqual(jasmine.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors' }));
  });
  it('loads verified fonts before rendering and isolates font families from application UI', async () => {
    const result = await service.prepare(source(`@font-face{font-family:Example;src:url("${url}");font-weight:100 900;size-adjust:110%}p{font-family:Example}`), 'display', { [url]: await sha256(bytes) });
    expect(window.FontFace).toHaveBeenCalledWith(jasmine.any(String), jasmine.any(ArrayBuffer), jasmine.objectContaining({weight:'100 900',sizeAdjust:'110%'}));
    expect(document.fonts.add).toHaveBeenCalled(); expect(result.results[0].status).toBe('verified'); expect(result.families[0].alias).toMatch(/^wdoc-/);
    expect(decodeUtf8(result.files['index.html'])).toContain(`font-family:${result.families[0].alias}`); expect(decodeUtf8(result.files['index.html'])).not.toContain('@font-face');
    service.activate(result); expect(service.restoreFamilies(result.families[0].alias)).toBe('Example'); service.clear(); expect(document.fonts.delete).toHaveBeenCalled();
  });
  it('uses embedded copies without permission or network and exports unchanged protected sources', async () => {
    const hash = await sha256(bytes), original = source(); original[`wdoc-font-cache/${hash}`] = bytes;
    trust.permitted.and.returnValue(false);
    const result = await service.prepare(original, 'embed', { [url]: hash });
    expect(fetcher).not.toHaveBeenCalled(); expect(result.files['index.html']).toEqual(original['index.html']); expect(result.files[`wdoc-font-cache/${hash}`]).toEqual(bytes);
  });
  it('rejects digest mismatches without loading them, with a separate display result', async () => {
    const hash = await sha256(encoder.encode('different'));
    const result = await service.prepare(source(), 'display', { [url]: hash });
    expect(result.results[0].status).toBe('mismatch'); expect(document.fonts.add).not.toHaveBeenCalled();
    await expectAsync(service.prepare(source(), 'pin', { [url]: hash })).toBeRejectedWithError(/mismatch/);
  });
  it('reports refusal, network errors, invalid binaries, and browser decode failures', async () => {
    trust.permitted.and.returnValue(false); expect((await service.prepare(source(), 'display')).results[0].status).toBe('refused'); expect(fetcher).not.toHaveBeenCalled();
    trust.permitted.and.returnValue(true); fetcher.and.rejectWith(new Error('Offline')); expect((await service.prepare(source(), 'display')).results[0].status).toBe('unavailable');
    fetcher.and.callFake(async () => new Response('<html>Error</html>')); expect((await service.prepare(source(), 'display')).results[0].status).toBe('invalid');
    fetcher.and.callFake(async () => new Response(new Uint8Array(bytes))); (window.FontFace as unknown as jasmine.Spy).and.callFake(() => ({ load: () => Promise.reject(new Error('Decoder')) }));
    expect((await service.prepare(source(), 'display')).results[0].status).toBe('invalid');
  });
  it('reduces provider stylesheets to font faces and checks file origins independently', async () => {
    fetcher.and.callFake(async (value: RequestInfo | URL) => String(value).endsWith('/css2?family=Example') ? new Response(`body{background:url(https://tracker.example/a)} @import "https://tracker.example/css"; @font-face{font-family:Example;src:url(/regular.woff2);font-weight:100 900}`) : new Response(new Uint8Array(bytes)));
    const files = { 'index.html': encoder.encode('<html><head><link rel="stylesheet" href="https://fonts.example.test/css2?family=Example"></head><body></body></html>') };
    const result = await service.prepare(files, 'pin'); const html = decodeUtf8(result.files['index.html']);
    expect(html).toContain('@font-face'); expect(html).not.toContain('tracker.example'); expect(html).not.toContain('<link');
    expect(fetcher.calls.count()).toBe(2); expect(result.externalFonts[url]).toBe(await sha256(bytes)); expect(trust.authorize).toHaveBeenCalledTimes(2);
  });
  it('expands remote CSS imports while preserving local rules and caches verified bytes', async () => {
    fetcher.and.callFake(async (value: RequestInfo | URL) => String(value).endsWith('.css') ? new Response(`@font-face{font-family:Example;src:url("${url}")}`) : new Response(new Uint8Array(bytes)));
    const files = source('@import "https://fonts.example.test/font.css";p{color:red}');
    const result = await service.prepare(files, 'embed'); expect(decodeUtf8(result.files['index.html'])).toContain('color:red'); expect(decodeUtf8(result.files['index.html'])).not.toContain('@import');
    fetcher.calls.reset(); const fresh = TestBed.inject(ExternalFontService); await fresh.prepare(result.files, 'pin', result.externalFonts); expect(fetcher).not.toHaveBeenCalled();
  });
  it('pins the exact stylesheet and font bytes used for display without fetching a newer provider response', async () => {
    fetcher.and.callFake(async (value: RequestInfo | URL) => String(value).endsWith('/css2?family=Example') ? new Response(`@font-face{font-family:Example;src:url("${url}")}`) : new Response(new Uint8Array(bytes)));
    const files = { 'index.html': encoder.encode('<html><head><link rel="stylesheet" href="https://fonts.example.test/css2?family=Example"></head><body></body></html>') };
    const displayed = await service.prepare(files, 'display'); service.activate(displayed);
    fetcher.and.rejectWith(new Error('Provider changed or went offline'));
    const pinned = await service.prepare(files, 'pin');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(pinned.externalFonts[url]).toBe(await sha256(bytes)); expect(decodeUtf8(pinned.files['index.html'])).toContain(url);
  });
  it('retains bytes for documents without remote fonts and validates editor font inputs', async () => {
    const files = { 'index.html': encoder.encode('<p>Untouched bytes</p>') }; expect((await service.prepare(files, 'pin')).files['index.html']).toEqual(files['index.html']);
    await expectAsync(service.add('Bad;family', url)).toBeRejected(); await expectAsync(service.add('Example', 'http://unsafe.example/font.woff2')).toBeRejected();
    await service.add('Example', url); expect(service.authoringCss).toContain('@font-face'); expect(service.families()[0].name).toBe('Example');
  });
  it('disposes a late font load instead of activating it in a different document', async () => {
    let finish!: (response: Response) => void;
    fetcher.and.returnValue(new Promise<Response>(resolve => finish = resolve));
    const adding = service.add('Example', url);
    service.clear();
    finish(new Response(new Uint8Array(bytes)));
    await expectAsync(adding).toBeRejectedWithError(/document changed/);
    expect(service.families()).toEqual([]);
    expect(service.authoringCss).toBe('');
    expect(document.fonts.delete).toHaveBeenCalled();
  });
});
