import { computed, Injectable, signal } from '@angular/core';
import { DEFAULT_DOCUMENT_FONT_FAMILY } from '../layout/layout.constants';
import { cssUrls, decodeUtf8, encoder, externalFontUrl, fontFaceBlocks, runtimePath, safePath, sha256, type Files } from '../signatures/core';
import { FontPermissions, FontTrustService } from './font-trust.service';

export interface FontResult { url: string; status: 'verified' | 'unpinned' | 'unavailable' | 'refused' | 'mismatch' | 'invalid'; detail: string }
export interface FontFamily { name: string; alias: string }
export interface FontPreparation {
  files: Files; externalFonts: Record<string, string>; css: string; localAssets: Files;
  families: FontFamily[]; defaultFamily: string; results: FontResult[]; dispose: () => void;
}
type Mode = 'display' | 'pin' | 'embed';
const IMPORT = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|@import\s+(?:url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|"([^"]*)"|'([^']*)')\s*[^;]*;/gi;
const DESCRIPTORS = ['font-family', 'font-style', 'font-weight', 'font-stretch', 'unicode-range', 'font-feature-settings', 'font-variation-settings', 'font-display', 'ascent-override', 'descent-override', 'line-gap-override', 'size-adjust'];

@Injectable({ providedIn: 'root' })
export class ExternalFontService {
  readonly results = signal<FontResult[]>([]);
  readonly families = signal<FontFamily[]>([]);
  readonly defaultFamily = signal(DEFAULT_DOCUMENT_FONT_FAMILY);
  readonly hasProblems = computed(() => this.results().some(font => !['verified', 'unpinned'].includes(font.status)));
  authoringCss = '';
  localAssets: Files = Object.create(null);
  private active?: FontPreparation;
  private permissions: FontPermissions = { allowed: new Set(), denied: new Set() };
  private documentId = crypto.randomUUID();
  private aliases = new Map<string, string>();
  private viewed = new Map<string, Uint8Array>();
  private stylesheetCache = new Map<string, string>();
  private memory = new Map<string, Uint8Array>();
  constructor(private trust: FontTrustService) {}

  activate(prepared: FontPreparation) {
    this.active?.dispose(); this.active = prepared;
    this.authoringCss = prepared.css; this.families.set(prepared.families); this.results.set(prepared.results);
    this.localAssets = prepared.localAssets;
    this.defaultFamily.set(prepared.defaultFamily);
  }
  beginDocument() { this.permissions = { allowed: new Set(), denied: new Set() }; this.documentId = crypto.randomUUID(); this.aliases.clear(); this.viewed.clear(); this.stylesheetCache.clear(); }
  clear() { this.active?.dispose(); this.active = undefined; this.authoringCss = ''; this.localAssets = Object.create(null); this.families.set([]); this.results.set([]); this.defaultFamily.set(DEFAULT_DOCUMENT_FONT_FAMILY); this.beginDocument(); }
  restoreFamilies(html: string): string {
    for (const family of this.families()) html = html.replaceAll(family.alias, family.name);
    return html;
  }
  async add(family: string, value: string, weight = '400', style = 'normal'): Promise<void> {
    const documentId = this.documentId;
    const url = new URL(value).href;
    if (!externalFontUrl(url)) throw new Error('Use a public HTTPS font or font stylesheet URL.');
    if (!family.trim() || /[\n\r{};"'\\<>]/.test(family) || !/^(?:[1-9]00|[1-9]00 [1-9]00)$/.test(weight) || !['normal', 'italic'].includes(style)) throw new Error('Enter a font family, weight, and style.');
    const css = /\.css(?:\?|$)|\/css2?(?:\?|$)/i.test(url)
      ? `<link rel="stylesheet" href="${url.replaceAll('&', '&amp;')}">`
      : `<style>@font-face {font-family:"${family.trim()}";font-weight:${weight};font-style:${style};src:url("${url}");}</style>`;
    const prepared = await this.prepare({ ...this.localAssets, 'index.html': encoder.encode(`<html><head><style>${this.authoringCss}</style>${css}</head><body></body></html>`) }, 'display');
    if (documentId !== this.documentId) { prepared.dispose(); throw new Error('The document changed while the font was loading. Choose the font again.'); }
    if (prepared.results.some(result => !['verified', 'unpinned'].includes(result.status))) { prepared.dispose(); throw new Error('The font could not be loaded. Check its URL and Font settings.'); }
    prepared.defaultFamily = this.defaultFamily();
    this.activate(prepared);
  }

  async prepare(source: Files, mode: Mode, expected: Record<string, string> = {}): Promise<FontPreparation> {
    const files: Files = { ...source };
    const originals = Object.keys(source).filter(path => !runtimePath(path) && path !== 'manifest.json' && /\.(?:html?|css)$/i.test(path));
    const permissions = this.permissions;
    let totalBytes = 0;
    const faces: FontFace[] = [], families = new Map<string, string>(), results = new Map<string, FontResult>();
    const externalFonts: Record<string, string> = Object.create(null);
    const originalCss: string[] = [];
    const localAssets: Files = Object.create(null);
    const downloaded = new Map<string, Uint8Array>();
    const sheets = new Map<string, string>();
    const documents = new Map<string, Document>();
    const texts = new Map<string, string>();
    const stylesheets = new Set<string>();
    const fail = (url: string, status: FontResult['status'], detail: string): undefined => {
      results.set(url, { url, status, detail });
      if (mode !== 'display') throw new Error(`External font ${status}: ${url}. ${detail}`);
      return undefined;
    };
    const request = async (url: string, limit: number): Promise<Uint8Array> => {
      if (!this.trust.permitted(url, permissions!)) throw new Error('Loading this source was not permitted.');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
        if (!response.ok || !response.body || response.redirected) throw new Error('The source is unavailable or does not allow CORS.');
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; totalBytes += value.byteLength;
            if (size > limit || totalBytes > 30_000_000) { controller.abort(); throw new Error('External font resources exceed size limits.'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return bytes;
      } finally { clearTimeout(timer); }
    };
    const imports = (css: string) => Array.from(css.matchAll(IMPORT)).filter(m => m[0].startsWith('@')).map(m => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim());
    for (const path of originals) {
      const text = decodeUtf8(source[path]);
      if (/\.css$/i.test(path)) texts.set(path, text);
      else {
        const doc = new DOMParser().parseFromString(text, 'text/html'); documents.set(path, doc);
        for (const link of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
          const url = link.getAttribute('href')!; if (externalFontUrl(url)) stylesheets.add(url);
        }
        for (const style of Array.from(doc.querySelectorAll('style'))) for (const url of imports(style.textContent ?? '')) if (externalFontUrl(url)) stylesheets.add(url);
      }
    }
    for (const css of texts.values()) for (const url of imports(css)) if (externalFontUrl(url)) stylesheets.add(url);
    if (stylesheets.size > 64) throw new Error('Too many external font stylesheets.');
    await this.trust.authorize([...stylesheets].filter(url => !this.stylesheetCache.has(url)), permissions);
    for (const url of stylesheets) {
      const cached = this.stylesheetCache.get(url);
      if (cached !== undefined) { sheets.set(url, cached); continue; }
      if (!this.trust.permitted(url, permissions)) { fail(url, 'refused', 'Loading this source was not permitted.'); sheets.set(url, ''); continue; }
      try {
        const text = decodeUtf8(await request(url, 1_000_000));
        const css = fontFaceBlocks(text).map(block => {
          const sheet = new CSSStyleSheet(); sheet.replaceSync(block.text);
          const rule = sheet.cssRules[0] as CSSFontFaceRule | undefined;
          if (!rule || rule.type !== CSSRule.FONT_FACE_RULE) return '';
          const src = cssUrls(rule.style.getPropertyValue('src')).map(ref => new URL(ref, url).href).filter(externalFontUrl);
          if (!src.length) return '';
          const descriptors = DESCRIPTORS.map(name => rule.style.getPropertyValue(name) ? `${name}:${rule.style.getPropertyValue(name)};` : '').join('');
          return `@font-face {${descriptors}src:${src.map(ref => `url(${JSON.stringify(ref)})`).join(',')};}`;
        }).join('\n');
        if (!css) throw new Error('No supported font declarations were found.');
        sheets.set(url, css);
        this.stylesheetCache.set(url, css);
      } catch (error) { fail(url, 'unavailable', (error as Error).message); sheets.set(url, ''); }
    }
    const expand = (text: string) => text.replace(IMPORT, (token, ...groups: string[]) => {
      if (!token.startsWith('@')) return token;
      const url = groups.slice(0, 5).find(value => value !== undefined)?.trim() ?? '';
      return externalFontUrl(url) ? sheets.get(url) ?? '' : token;
    });
    for (const [path, css] of texts) texts.set(path, expand(css));
    for (const doc of documents.values()) {
      for (const link of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
        const url = link.getAttribute('href')!; if (!externalFontUrl(url)) continue;
        const style = doc.createElement('style'); style.textContent = (sheets.get(url) ?? '').replace(/<\/style/gi, '<\\/style'); link.replaceWith(style);
      }
      for (const style of Array.from(doc.querySelectorAll('style'))) style.textContent = expand(style.textContent ?? '');
    }
    const allCss = [...texts.values(), ...Array.from(documents.values()).flatMap(doc => Array.from(doc.querySelectorAll('style')).map(style => style.textContent ?? ''))];
    if (allCss.reduce((count, css) => count + fontFaceBlocks(css).length, 0) > 256) throw new Error('Too many font face declarations.');
    const urls = new Set(allCss.flatMap(css => fontFaceBlocks(css).flatMap(block => {
      const src = /(?:^|;)\s*src\s*:\s*([^;]*)/i.exec(block.body); return src ? cssUrls(src[1]).filter(externalFontUrl) : [];
    })));
    if (mode !== 'display') for (const url of Object.keys(expected)) urls.add(url);
    if (urls.size > 64) throw new Error('Too many external fonts.');
    const missing = [...urls].filter(url => !source[`wdoc-font-cache/${expected[url]}`] && !this.memory.has(expected[url]) && !(expected[url] === undefined && this.viewed.has(url)));
    // Persistent cached bytes are read before deciding whether a network permission is needed.
    for (const url of missing) if (expected[url]) { const cached = await this.cached(expected[url]); if (cached) downloaded.set(url, cached); }
    await this.trust.authorize(missing.filter(url => !downloaded.has(url)), permissions);
    for (const url of urls) {
      const hash = expected[url];
      let bytes = (hash ? source[`wdoc-font-cache/${hash}`] ?? this.memory.get(hash) : this.viewed.get(url)) ?? downloaded.get(url);
      if (!bytes && !this.trust.permitted(url, permissions)) { fail(url, 'refused', 'Loading this source was not permitted.'); continue; }
      try { bytes ??= await request(url, 10_000_000); }
      catch (error) { fail(url, 'unavailable', (error as Error).message); continue; }
      if (bytes.length > 10_000_000 || !this.fontBytes(bytes)) { fail(url, 'invalid', 'The source is not a supported WOFF2, WOFF, TrueType, or OpenType font.'); continue; }
      const actual = await sha256(bytes);
      if (hash && actual !== hash) { fail(url, 'mismatch', 'The font does not match its protected SHA-256 fingerprint.'); continue; }
      downloaded.set(url, bytes); externalFonts[url] = actual;
      this.viewed.set(url, bytes);
      results.set(url, { url, status: hash ? 'verified' : 'unpinned', detail: hash ? 'Font bytes match the manifest.' : 'Font loaded without a protected fingerprint.' });
      await this.remember(actual, bytes);
      if (mode === 'embed') files[`wdoc-font-cache/${actual}`] = bytes;
    }
    const render = async (css: string, path: string): Promise<string> => {
      let output = css, offset = 0;
      for (const block of fontFaceBlocks(css)) {
        const src = /(?:^|;)\s*src\s*:\s*([^;]*)/i.exec(block.body);
        const remote = src ? cssUrls(src[1]).filter(externalFontUrl) : [];
        const local: Array<{ ref: string; path: string; bytes: Uint8Array }> = [];
        for (const ref of src ? cssUrls(src[1]) : []) {
          try {
            const resolved = new URL(ref, `https://archive.invalid/${path}`), file = decodeURIComponent(resolved.pathname.slice(1));
            if (resolved.origin === 'https://archive.invalid' && safePath(file) && !runtimePath(file) && source[file] && this.fontBytes(source[file])) {
              const bytes = source[file], magic = String.fromCharCode(...bytes.slice(0, 4));
              const target = `wdoc-assets/fonts/${await sha256(bytes)}.${magic === 'wOF2' ? 'woff2' : magic === 'wOFF' ? 'woff' : magic === 'OTTO' ? 'otf' : 'ttf'}`;
              localAssets[target] = bytes; local.push({ ref, path: target, bytes });
            }
          } catch { /* Unsupported local references retain the existing CSS resource behavior. */ }
        }
        const pinned = remote.length ? block.text.replace(/local\s*\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)\s*,?\s*/gi, '') : block.text;
        let authoring = pinned;
        for (const asset of local) authoring = authoring.replaceAll(asset.ref, asset.path);
        originalCss.push(authoring);
        const index = block.index + offset;
        if (mode !== 'display') { output = output.slice(0, index) + pinned + output.slice(index + block.text.length); offset += pinned.length - block.text.length; continue; }
        if (!remote.length && (!local.length || /local\s*\(/i.test(src?.[1] ?? ''))) continue;
        const sheet = new CSSStyleSheet(); sheet.replaceSync(pinned);
        const rule = sheet.cssRules[0] as CSSFontFaceRule | undefined;
        const name = rule?.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '');
        const bytes = remote.length ? downloaded.get(remote.find(url => downloaded.has(url)) ?? '') : local[0]?.bytes;
        let loaded = false;
        if (name && bytes && rule) {
          const alias = this.aliases.get(name) ?? `wdoc-${this.documentId}-${this.aliases.size}`; this.aliases.set(name, alias); families.set(name, alias);
          const descriptors: FontFaceDescriptors = {};
          for (const [cssName, key] of [['font-style', 'style'], ['font-weight', 'weight'], ['font-stretch', 'stretch'], ['unicode-range', 'unicodeRange'], ['font-feature-settings', 'featureSettings'], ['font-variation-settings', 'variationSettings'], ['ascent-override', 'ascentOverride'], ['descent-override', 'descentOverride'], ['line-gap-override', 'lineGapOverride'], ['size-adjust', 'sizeAdjust']] as const) {
            const value = rule.style.getPropertyValue(cssName); if (value) (descriptors as Record<string, string>)[key] = value;
          }
          try {
            const face = new FontFace(alias, new Uint8Array(bytes).buffer, descriptors);
            await face.load(); document.fonts.add(face); faces.push(face); loaded = true;
          } catch { for (const url of remote) fail(url, 'invalid', 'The browser could not decode this font.'); }
        }
        if (!remote.length && !loaded) continue;
        output = output.slice(0, index) + output.slice(index + block.text.length); offset -= block.text.length;
      }
      return output;
    };
    try {
      for (const [path, css] of texts) texts.set(path, await render(css, path));
      for (const [path, doc] of documents) for (const style of Array.from(doc.querySelectorAll('style'))) style.textContent = (await render(style.textContent ?? '', path)).replace(/<\/style/gi, '<\\/style');
      const aliasDeclarations = (text: string) => text.replace(/\b(font-family|font)\s*:\s*([^;}]+)/gi, (declaration) => {
        for (const [name, alias] of families) declaration = declaration.replace(new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), alias);
        return declaration;
      });
      for (const [path, css] of texts) files[path] = encoder.encode(mode === 'display' ? aliasDeclarations(css) : css);
      for (const [path, doc] of documents) {
        if (mode === 'display') {
          for (const style of Array.from(doc.querySelectorAll('style'))) style.textContent = aliasDeclarations(style.textContent ?? '');
          for (const element of Array.from(doc.querySelectorAll('[style]'))) element.setAttribute('style', aliasDeclarations(element.getAttribute('style')!));
        }
        // Preserve original document bytes when normalization made no changes.
        const original = new DOMParser().parseFromString(decodeUtf8(source[path]), 'text/html');
        if (doc.documentElement.outerHTML !== original.documentElement.outerHTML) files[path] = encoder.encode((decodeUtf8(source[path]).match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '') + doc.documentElement.outerHTML);
      }
      let defaultFamily = DEFAULT_DOCUMENT_FONT_FAMILY;
      for (const css of allCss) for (const match of css.matchAll(/(?:^|})\s*(?:body|html)\s*\{([^}]*)}/gi)) {
        const style = document.createElement('span').style; style.cssText = aliasDeclarations(match[1]); if (style.fontFamily) defaultFamily = style.fontFamily;
      }
      const inlineFamily = documents.get('index.html')?.body.style.fontFamily;
      if (inlineFamily) defaultFamily = inlineFamily;
      return { files, externalFonts, css: [...new Set(originalCss)].join('\n'), localAssets, defaultFamily, families: Array.from(families, ([name, alias]) => ({ name, alias })), results: [...results.values()], dispose: () => { for (const face of faces) document.fonts.delete(face); } };
    } catch (error) { for (const face of faces) document.fonts.delete(face); throw error; }
  }
  private fontBytes(bytes: Uint8Array): boolean {
    const magic = String.fromCharCode(...bytes.slice(0, 4));
    return bytes.length >= 12 && (['wOF2', 'wOFF', 'OTTO', 'true'].includes(magic) || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0));
  }
  private async cached(hash: string): Promise<Uint8Array | undefined> {
    try { const response = await (await caches.open('wdoc-font-bytes-v1')).match(`https://wdoc-font-cache.invalid/${hash}`); return response ? new Uint8Array(await response.arrayBuffer()) : undefined; } catch { return undefined; }
  }
  private async remember(hash: string, bytes: Uint8Array): Promise<void> {
    if (this.memory.size >= 32) this.memory.delete(this.memory.keys().next().value!);
    this.memory.set(hash, bytes);
    try {
      const cache = await caches.open('wdoc-font-bytes-v1'), keys = await cache.keys();
      if (keys.length >= 16) await cache.delete(keys[0]);
      await cache.put(`https://wdoc-font-cache.invalid/${hash}`, new Response(new Uint8Array(bytes)));
    } catch { /* Cache storage is optional and never determines integrity. */ }
  }
}
