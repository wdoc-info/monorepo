import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import { FontTrustService, FontPermissions } from './font-trust.service';
import { FontSettingsComponent } from './font-settings.component';
import { FontPermissionDialogComponent } from './font-permission-dialog.component';

describe('Font origin permissions', () => {
  let service: FontTrustService; let dialog: jasmine.SpyObj<MatDialog>; let session: FontPermissions;
  beforeEach(() => {
    localStorage.removeItem('wdoc-font-trust-v1');
    dialog = jasmine.createSpyObj('MatDialog', ['open']); dialog.open.and.returnValue({ afterClosed: () => of(undefined) } as any);
    TestBed.configureTestingModule({ providers: [{ provide: MatDialog, useValue: dialog }] });
    service = TestBed.inject(FontTrustService); session = { allowed: new Set(), denied: new Set() };
  });
  afterEach(() => localStorage.removeItem('wdoc-font-trust-v1'));
  it('automatically permits only the configured HTTPS sources and dedicated paths', async () => {
    const urls = ['https://fonts.googleapis.com/css2?family=Inter', 'https://fonts.gstatic.com/s/inter/a.woff2', 'https://fonts.bunny.net/inter/a.woff2', 'https://cdn.jsdelivr.net/fontsource/fonts/inter@5/latin-400-normal.woff2'];
    await service.authorize(urls, session);
    expect(dialog.open).not.toHaveBeenCalled(); for (const url of urls) expect(service.permitted(url, session)).toBeTrue();
    for (const url of ['http://fonts.gstatic.com/s/a', 'https://evil.fonts.gstatic.com/s/a', 'https://fonts.gstatic.com/other/a', 'https://cdn.jsdelivr.net/npm/arbitrary/a', 'https://fonts.googleapis.com/unrelated']) expect(service.permitted(url, session)).toBeFalse();
  });
  it('groups unknown origins, remembers permanent trust, and keeps refusal document-scoped', async () => {
    dialog.open.and.returnValue({ afterClosed: () => of({ 'https://one.example': 'always', 'https://two.example': 'once', 'https://three.example': 'deny' }) } as any);
    await service.authorize(['https://one.example/a', 'https://one.example/b', 'https://two.example/a', 'https://three.example/a'], session);
    expect((dialog.open.calls.mostRecent().args[1]?.data as { origins: string[] }).origins).toEqual(['https://one.example', 'https://three.example', 'https://two.example']);
    const fresh = { allowed: new Set<string>(), denied: new Set<string>() };
    expect(service.permitted('https://one.example/a', fresh)).toBeTrue(); expect(service.permitted('https://two.example/a', fresh)).toBeFalse();
    expect(service.permitted('https://two.example/a', session)).toBeTrue(); expect(service.permitted('https://three.example/a', session)).toBeFalse();
    await service.authorize(['https://one.example/c', 'https://two.example/b'], session); expect(dialog.open).toHaveBeenCalledTimes(1);
  });
  it('lets explicit blocks override defaults and resets stored permissions', async () => {
    service.set('https://fonts.gstatic.com', 'block'); await service.authorize(['https://fonts.gstatic.com/s/a'], session);
    expect(service.permitted('https://fonts.gstatic.com/s/a', session)).toBeFalse(); expect(dialog.open).not.toHaveBeenCalled();
    service.set('https://fonts.gstatic.com', 'default'); expect(service.preferences['https://fonts.gstatic.com']).toBeUndefined();
    for (const origin of ['https://a.example/path', 'http://a.example', 'https://a.example:443', 'https://user@a.example']) expect(() => service.set(origin, 'allow')).toThrow();
  });
  it('ignores invalid persisted policies and supports storage-disabled browsers', () => {
    localStorage.setItem('wdoc-font-trust-v1', '{"https://ok.example":"allow","http://bad.example":"allow","https://unknown.example":"yes"}');
    expect(service.preferences).toEqual({ 'https://ok.example': 'allow' });
    spyOn(Storage.prototype, 'getItem').and.throwError('Disabled'); spyOn(Storage.prototype, 'setItem').and.throwError('Disabled');
    service.set('https://new.example', 'allow'); expect(service.preferences['https://new.example']).toBe('allow');
  });
  it('offers settings and defaults each prompt to document-only permission', () => {
    const prompt = new FontPermissionDialogComponent({ origins: ['https://one.example'] }, {} as any);
    expect(prompt.choices['https://one.example']).toBe('once');
    const settings = new FontSettingsComponent(service); settings.origin = 'http://bad.example'; settings.add(); expect(settings.error).toContain('HTTPS');
    settings.origin = 'https://new.example'; settings.add(); expect(settings.error).toBe(''); expect(service.sources).toContain('https://new.example');
  });
});
