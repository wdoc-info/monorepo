import DOMPurify from 'dompurify';
import { safePath } from '../signatures/validation';
import type { Snapshot } from './git-engine';
export interface VisualConflict { path: string; label: string; ours?: Uint8Array; theirs?: Uint8Array; choice?: 'ours' | 'theirs'; fonts?: boolean; block?: number; text?: string }
const encoder = new TextEncoder(), decoder = new TextDecoder();
const equal = (a?: Uint8Array, b?: Uint8Array) => a === b || (!!a && !!b && a.length === b.length && a.every((v, n) => v === b[n]));
const parse = (bytes: Uint8Array) => new DOMParser().parseFromString(decoder.decode(bytes), 'text/html');
const content = (doc: Document) => doc.querySelector('wdoc-content') ?? doc.body;
const serialize = (doc: Document) => encoder.encode('<!doctype html>\n' + doc.documentElement.outerHTML);

/** Merge independent files and independent visual blocks; ambiguous structure stays explicit. */
export class VisualMerge {
  readonly files: Snapshot = {};
  readonly conflicts: VisualConflict[] = [];
  private html?: Document;
  constructor(base: Snapshot | null, ours: Snapshot, theirs: Snapshot) {
    this.mergeFontMetadata(base, ours, theirs);
    for (const path of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      if (path === 'manifest.json' || path.startsWith('.git/') || /^(seals|revisions|submissions)\//.test(path)) continue;
      const a = ours[path], b = theirs[path], original = base?.[path];
      if (equal(a, b) || (base && equal(b, original))) { if (a) this.files[path] = a; }
      else if (base && equal(a, original)) { if (b) this.files[path] = b; }
      else if (path === 'index.html' && a && b && original && this.blocks(original, a, b)) { /* Conflicts refer to rendered blocks. */ }
      else this.conflicts.push({ path, label: path === 'index.html' ? 'Document layout and content' : path, ours: a, theirs: b });
    }
  }
  private mergeFontMetadata(base: Snapshot | null, ours: Snapshot, theirs: Snapshot): void {
    const manifest = (files: Snapshot | null): any => { try { return JSON.parse(decoder.decode(files?.['manifest.json'])); } catch { return undefined; } };
    const a = manifest(ours), b = manifest(theirs), original = manifest(base);
    if (!a) return;
    const encode = (value: unknown) => encoder.encode(JSON.stringify(value ?? {}));
    const af = encode(a.content?.externalFonts), bf = encode(b?.content?.externalFonts), old = encode(original?.content?.externalFonts);
    if (equal(af, bf) || (base && equal(bf, old))) { /* Keep the current declaration. */ }
    else if (base && equal(af, old)) { a.content.externalFonts = b?.content?.externalFonts; }
    else this.conflicts.push({ path: 'manifest.json', label: 'External font references', ours: af, theirs: bf, fonts: true });
    this.files['manifest.json'] = encoder.encode(JSON.stringify(a));
  }
  private blocks(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): boolean {
    const d0 = parse(base), da = parse(ours), db = parse(theirs);
    const root0 = content(d0), ra = content(da), rb = content(db);
    const zero = [...root0.children], a = [...ra.children], b = [...rb.children];
    // Structural edits, styles and page shells require an explicit whole-document choice.
    const shell = (doc: Document) => { const copy = doc.cloneNode(true) as Document; content(copy).replaceChildren(); return copy.documentElement.outerHTML; };
    if (shell(d0) !== shell(da) || shell(d0) !== shell(db) || zero.length !== a.length || a.length !== b.length) return false;
    for (let n = 0; n < a.length; n++) {
      if (a[n].outerHTML === b[n].outerHTML || b[n].outerHTML === zero[n].outerHTML) continue;
      if (a[n].outerHTML === zero[n].outerHTML) a[n].replaceWith(b[n].cloneNode(true));
      else this.conflicts.push({ path: 'index.html', label: `Content block ${n + 1}`, ours: encoder.encode(a[n].outerHTML), theirs: encoder.encode(b[n].outerHTML), block: n });
    }
    this.html = da; this.files['index.html'] = serialize(da); return true;
  }
  resolve(): Snapshot {
    const result = { ...this.files };
    for (const conflict of this.conflicts) {
      if (!conflict.choice) throw new Error('Choose a version for every conflict');
      const bytes = conflict[conflict.choice];
      if (conflict.fonts) {
        const manifest = JSON.parse(decoder.decode(result['manifest.json']));
        manifest.content.externalFonts = JSON.parse(decoder.decode(bytes));
        result['manifest.json'] = encoder.encode(JSON.stringify(manifest));
      } else if (conflict.block !== undefined && this.html) {
        const node = content(this.html).children[conflict.block];
        if (conflict.text !== undefined && !node.querySelector('table,form,input,img') && /^(P|H[1-6]|BLOCKQUOTE|PRE)$/.test(node.tagName)) node.textContent = conflict.text;
        else if (bytes) node.replaceWith(parse(bytes).body.firstElementChild!.cloneNode(true));
      } else if (bytes) result[conflict.path] = bytes;
      else delete result[conflict.path];
    }
    if (this.html) result['index.html'] = serialize(this.html);
    return result;
  }
}

/** Inert preview: sanitize, inline local resources, block scripts and all remote requests. */
export function preview(files: Snapshot): string {
  const doc = parse(files['index.html'] ?? encoder.encode('<p>No preview available</p>'));
  for (const node of doc.querySelectorAll('script,iframe,object,embed,base,meta[http-equiv]')) node.remove();
  const resolve = (path: string, base = 'index.html'): string => {
    try { const url = new URL(path, 'https://preview.invalid/' + base); const result = decodeURIComponent(url.pathname.slice(1)); return url.origin === 'https://preview.invalid' && safePath(result) ? result : ''; } catch { return ''; }
  };
  let resourceChars = 0;
  const dataUrl = (path: string, base = 'index.html'): string => {
    if (/^data:(image\/(png|jpeg|gif|webp|avif|svg\+xml)|font\/|application\/(font|octet-stream))/i.test(path)) { resourceChars += path.length; return resourceChars <= 30_000_000 ? path : ''; }
    path = resolve(path, base);
    const bytes = files[path.replace(/^\.\//, '')];
    if (!bytes) return '';
    resourceChars += Math.ceil(bytes.length * 4 / 3); if (resourceChars > 30_000_000) return '';
    const ext = path.split('.').pop()?.toLowerCase();
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', gif: 'image/gif', avif: 'image/avif', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
    let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
    return `data:${mime};base64,${btoa(binary)}`;
  };
  let cssBytes = 0, imports = 0;
  const stylesheet = (path: string, visited = new Set<string>()): string => {
    if (!files[path] || visited.has(path) || visited.size > 32 || ++imports > 1000) return '';
    const seen = new Set(visited).add(path); let css = decoder.decode(files[path]);
    cssBytes += css.length; if (cssBytes > 30_000_000) return '';
    css = css.replace(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?[^;]*;/gi, (_, href) => stylesheet(resolve(href, path), seen));
    return css.replace(/@import[^;]+;/gi, '').replace(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g, (_, href) => `url("${dataUrl(href, path)}")`);
  };
  for (const link of doc.querySelectorAll('link')) {
    if (link.getAttribute('rel') === 'stylesheet') {
      const style = doc.createElement('style'); style.textContent = stylesheet(resolve(link.getAttribute('href') ?? '')); link.replaceWith(style);
    } else link.remove();
  }
  for (const [index, form] of [...doc.forms].entries()) {
    const entry = files[`wdoc-form/${form.id || `form-${index + 1}`}.json`];
    if (!entry) continue;
    try {
      const answers = JSON.parse(decoder.decode(entry));
      for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) {
        const answer = answers[control.name]; if (answer === undefined) continue;
        const values = (Array.isArray(answer) ? answer : [answer]).map(String);
        if (control instanceof HTMLInputElement) {
          if (['checkbox', 'radio'].includes(control.type)) control.toggleAttribute('checked', values.includes(control.value));
          else if (control.type !== 'file') control.setAttribute('value', values[0]);
        } else if (control instanceof HTMLTextAreaElement) control.textContent = values[0];
        else for (const option of control.options) option.toggleAttribute('selected', values.includes(option.value));
      }
    } catch { /* Unreadable editable drafts never affect the static preview. */ }
  }
  for (const node of doc.querySelectorAll('[src]')) node.setAttribute('src', dataUrl(node.getAttribute('src') ?? ''));
  for (const node of doc.querySelectorAll('style,[style]')) {
    const replace = (css: string) => css.replace(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g, (_, path) => `url("${dataUrl(path)}")`).replace(/@import[^;]+;/gi, '');
    if (node.tagName === 'STYLE') node.textContent = replace(node.textContent ?? ''); else node.setAttribute('style', replace(node.getAttribute('style') ?? ''));
  }
  const html = DOMPurify.sanitize(doc.documentElement.outerHTML, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style', 'wdoc-content', 'wdoc-page', 'wdoc-container', 'wdoc-header', 'wdoc-footer'] });
  return html.replace(/<head[^>]*>/i, `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">`);
}
