import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { DEFAULT_FONT_SOURCES } from '../config/font-sources.config';
import { externalFontUrl } from '../signatures/core';
import { FontPermission, FontPermissionDialogComponent } from './font-permission-dialog.component';

export interface FontPermissions { allowed: Set<string>; denied: Set<string> }
@Injectable({ providedIn: 'root' })
export class FontTrustService {
  private readonly key = 'wdoc-font-trust-v1';
  private memory: Record<string, 'allow' | 'block'> = Object.create(null);
  constructor(private dialog: MatDialog) {}
  get preferences(): Record<string, 'allow' | 'block'> {
    try {
      const value = JSON.parse(localStorage.getItem(this.key) ?? '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.memory = Object.fromEntries(Object.entries(value).filter(([origin, action]) => this.isOrigin(origin) && ['allow', 'block'].includes(action as string))) as Record<string, 'allow' | 'block'>;
      }
    } catch { /* Permissions remain usable when browser storage is disabled. */ }
    return { ...this.memory };
  }
  get sources(): string[] { return Array.from(new Set([...DEFAULT_FONT_SOURCES.map(s => s.origin), ...Object.keys(this.preferences)])); }
  set(origin: string, action: 'allow' | 'block' | 'default'): void {
    if (!this.isOrigin(origin)) throw new Error('Use an exact HTTPS origin.');
    const next = this.preferences;
    if (action === 'default') delete next[origin]; else next[origin] = action;
    this.memory = next;
    try { localStorage.setItem(this.key, JSON.stringify(next)); } catch { /* Keep this browser session's preference. */ }
  }
  private isOrigin(value: string): boolean { try { return externalFontUrl(value + '/') && new URL(value).origin === value; } catch { return false; } }
  private automatic(url: URL): boolean {
    return DEFAULT_FONT_SOURCES.some(source => source.origin === url.origin && source.paths.some(path => source.exact ? url.pathname === path : url.pathname.startsWith(path)));
  }
  async authorize(urls: string[], session: FontPermissions): Promise<void> {
    const preferences = this.preferences;
    const unknown = new Set<string>();
    for (const value of urls) {
      if (!externalFontUrl(value)) continue;
      const url = new URL(value), choice = preferences[url.origin];
      if (choice === 'block') { session.denied.add(url.origin); continue; }
      if (session.allowed.has(url.origin) || session.denied.has(url.origin)) continue;
      if (choice === 'allow') session.allowed.add(url.origin);
      else if (!this.automatic(url)) unknown.add(url.origin);
    }
    if (!unknown.size) return;
    const response = await firstValueFrom(this.dialog.open(FontPermissionDialogComponent, { data: { origins: [...unknown].sort() }, maxWidth: '560px', restoreFocus: false }).afterClosed()).catch(() => undefined) as Record<string, FontPermission> | undefined;
    for (const origin of unknown) {
      if (response?.[origin] === 'always') { this.set(origin, 'allow'); session.allowed.add(origin); }
      else if (response?.[origin] === 'once') session.allowed.add(origin);
      else session.denied.add(origin);
    }
  }
  permitted(value: string, session: FontPermissions): boolean {
    if (!externalFontUrl(value)) return false;
    const url = new URL(value), choice = this.preferences[url.origin];
    return choice !== 'block' && !session.denied.has(url.origin) && (choice === 'allow' || session.allowed.has(url.origin) || this.automatic(url));
  }
}
