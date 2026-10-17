import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom, firstValueFrom } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import DOMPurify from 'dompurify';
import { FormManagerService } from './form-manager.service';
import QRCode from 'qrcode';
import { QRCodeToDataURLOptions } from 'qrcode';
import JsBarcode from 'jsbarcode';
import { ExternalImageDialogComponent } from './external-image-dialog.component';
import { type ZipContainer } from './zip-reader';
import { decodeUtf8, safePath } from '../signatures/core';
import {
  DEFAULT_DOCUMENT_FONT,
  DEFAULT_DOCUMENT_LINE_HEIGHT_PX,
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_PADDING,
  DEFAULT_PAGE_WIDTH,
} from '../layout/layout.constants';
import { BlockExtractorService } from '../layout/block-extractor.service';
import { DocumentLayoutEngineService } from '../layout/document-layout-engine.service';

interface ProcessHtmlOptions {
  defaultTitle?: string;
  /** Directory containing index.html, relative to the root of the archive. */
  basePath?: string;
}

@Injectable({ providedIn: 'root' })
export class HtmlProcessingService {
  private paginationStyleEl?: HTMLStyleElement;
  private paginationHost?: HTMLElement;
  private paginationContainer?: HTMLElement;
  private objectUrls: string[] = [];
  private measuredPageHeight = DEFAULT_PAGE_HEIGHT;
  private readonly barcodeTypes = new Set([
    'codabar',
    'code128',
    'code39',
    'ean',
    'ean8',
    'ean13',
    'itf',
    'itf14',
    'msi',
    'pharmacode',
    'upc',
    'upca',
    'upce',
  ]);

  constructor(
    private http: HttpClient,
    private formManagerService: FormManagerService,
    private dialog: MatDialog,
    private blockExtractorService: BlockExtractorService,
    private documentLayoutEngineService: DocumentLayoutEngineService,
  ) {
    if (typeof document !== 'undefined') {
      this.paginationContainer = this.createPaginationContainer();
    }
  }

  async processHtml(
    zip: ZipContainer,
    html: string,
    options: ProcessHtmlOptions = {},
  ): Promise<{ html: string; documentTitle: string }> {
    // Start the viewer stylesheet request before asynchronous archive resource work.
    const viewerCss = lastValueFrom(this.http.get('assets/wdoc-styles.css', { responseType: 'text' })).catch(() => '');
    const sanitizedHtml = this.sanitizeHtml(html);
    const parser = new DOMParser();
    const doc = parser.parseFromString(sanitizedHtml, 'text/html');
    const documentTitle = this.updateDocumentTitle(
      doc,
      options.defaultTitle ?? 'WDOC viewer',
    );
    const basePath = options.basePath ?? '';

    const images = doc.querySelectorAll('img');
    for (const img of Array.from(images)) {
      const src = img.getAttribute('src');
      if (!src) {
        continue;
      }

      if (this.isExternalImage(src)) {
        const originalSrcset = img.getAttribute('srcset');
        img.removeAttribute('src');
        img.removeAttribute('srcset');

        const confirmLoad = await this.confirmExternalImageLoad(src);
        if (confirmLoad) {
          img.setAttribute('src', src);
          if (originalSrcset) {
            img.setAttribute('srcset', originalSrcset);
          }
        } else {
          img.remove();
        }
        continue;
      }

      const normalizedSrc = this.localResource(src, `${basePath}index.html`)?.path;
      if (!normalizedSrc) { img.removeAttribute('src'); continue; }
      const fileInZip = zip.file(normalizedSrc);
      if (fileInZip) {
        try {
          const blobContent = (await fileInZip.async('blob')) as Blob;
          const typedBlob = new Blob([blobContent], { type: this.getMimeType(normalizedSrc) });
          const objectUrl = URL.createObjectURL(typedBlob);
          this.objectUrls.push(objectUrl);
          img.setAttribute('src', objectUrl);
        } catch (error) {
          console.error(`Error reading image ${normalizedSrc} from zip:`, error);
        }
      } else {
        console.warn(`File ${normalizedSrc} not found in zip.`);
      }
    }

    if (doc.querySelector('a[href]')) {
      await this.replaceInternalLinks(zip, doc, basePath);
    }

    let combinedCSS = '';
    const indexPath = `${basePath}index.html`;
    const cssBudget = { imports: 0, urls: new Map<string, string>() };
    let cssCharacters = 0;
    const resolveStyle = async (text: string, path: string, stack = new Set<string>()) => {
      const css = await this.resolveCss(zip, text, path, stack, cssBudget);
      cssCharacters += css.length;
      if (cssCharacters > 30_000_000) throw new Error('Expanded stylesheet exceeds rendering limits.');
      return css;
    };
    const appendStyle = (css: string) => {
      if (++cssCharacters > 30_000_000) throw new Error('Expanded stylesheet exceeds rendering limits.');
      combinedCSS += css + '\n';
    };

    const headStyleEls = Array.from(doc.head.querySelectorAll('style'));
    for (const el of headStyleEls) {
      if (el.textContent) {
        appendStyle(await resolveStyle(el.textContent, indexPath));
      }
    }

    const headLinkEls = Array.from(doc.head.querySelectorAll('link[rel="stylesheet"]'));
    for (const linkEl of headLinkEls) {
      const href = linkEl.getAttribute('href');
      if (href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('data:')) {
        const normalizedHref = this.localResource(href, indexPath)?.path;
        if (!normalizedHref) continue;
        const cssFile = zip.file(normalizedHref);
        if (cssFile) {
          try {
            const cssContent = decodeUtf8(await cssFile.async('uint8array') as Uint8Array);
            appendStyle(await resolveStyle(cssContent, normalizedHref, new Set([normalizedHref])));
          } catch (error) {
            throw new Error('Unable to render the local stylesheet.');
          }
        }
      }
    }

    for (const element of Array.from(doc.body.querySelectorAll('[style]'))) {
      element.setAttribute('style', await resolveStyle(element.getAttribute('style') || '', indexPath));
    }
    for (const style of Array.from(doc.body.querySelectorAll('style'))) {
      style.textContent = (await resolveStyle(style.textContent || '', indexPath)).replace(/<\/style/gi, '<\\/style');
    }
    const builtinCss = await viewerCss;
    if (cssCharacters + builtinCss.length + 1 > 30_000_000) throw new Error('Expanded stylesheet exceeds rendering limits.');
    combinedCSS += builtinCss + '\n';

    this.applyPaginationStyles(combinedCSS);

    if (doc.head) {
      doc.head.remove();
    }

    const newStyleEl = doc.createElement('style');
    newStyleEl.textContent = combinedCSS.replace(/<\/style/gi, '<\\/style');
    doc.body.insertBefore(newStyleEl, doc.body.firstChild);

    await this.renderBarcodes(doc);

    if (!doc.querySelector('wdoc-page')) {
      const templateMeasurements = this.prepareTemplates(doc);
      await this.paginateContent(
        doc,
        templateMeasurements.headerHeight + templateMeasurements.footerHeight,
      );
      this.applyTemplatesToPages(doc, templateMeasurements);
    } else {
      if (doc.body.querySelector('wdoc-page') && !doc.body.querySelector('wdoc-container')) {
        const wdocContainer = doc.createElement('wdoc-container');
        while (doc.body.firstChild) {
          wdocContainer.appendChild(doc.body.firstChild);
        }
        doc.body.appendChild(wdocContainer);
      }
      const templateMeasurements = this.prepareTemplates(doc);
      this.applyTemplatesToPages(doc, templateMeasurements);
    }

    this.applyPageMetadata(doc);

    await this.formManagerService.populateFormsFromZip(zip, doc, basePath);
    return { html: doc.documentElement.outerHTML, documentTitle };
  }

  private sanitizeHtml(html: string): string {
    if (typeof window === 'undefined') {
      return html;
    }

    return DOMPurify.sanitize(html, {
      ADD_TAGS: [
        'wdoc-barcode',
        'wdoc-content',
        'wdoc-container',
        'wdoc-date',
        'wdoc-footer',
        'wdoc-header',
        'wdoc-nbpages',
        'wdoc-page',
        'wdoc-pagenum',
        'link',
      ],
      ADD_ATTR: ['errorcorrection', 'format', 'href', 'rel', 'type'],
      FORBID_TAGS: ['script', 'iframe'],
      WHOLE_DOCUMENT: true,
    });
  }

  private isExternalImage(src: string): boolean {
    return /^(?:https?:|\/\/|data:)/i.test(src);
  }

  /**
   * Turns links to files embedded in the archive into blob URLs. Relative URLs
   * would otherwise be resolved against the viewer application instead of the
   * .wdoc archive, especially when opened in a separate tab.
   */
  private async replaceInternalLinks(
    zip: ZipContainer,
    doc: Document,
    basePath: string,
  ): Promise<void> {
    const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));

    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href || this.isExternalLink(href)) {
        continue;
      }

      const resourcePath = href.split(/[?#]/, 1)[0];
      if (!resourcePath) {
        continue;
      }

      const filePath = this.localResource(resourcePath, `${basePath}index.html`)?.path;
      if (!filePath) continue;
      const fileInZip = zip.file(filePath);
      if (!fileInZip || fileInZip.dir) {
        continue;
      }

      try {
        const content = (await fileInZip.async('blob')) as Blob;
        const objectUrl = URL.createObjectURL(
          new Blob([content], { type: this.getMimeType(filePath) }),
        );
        this.objectUrls.push(objectUrl);

        // Keep any fragment or query intended for the embedded resource.
        link.href = `${objectUrl}${href.slice(resourcePath.length)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } catch (error) {
        console.error(`Error reading link target ${filePath} from zip:`, error);
      }
    }
  }

  private isExternalLink(href: string): boolean {
    return (
      href.startsWith('#') ||
      href.startsWith('//') ||
      /^[a-z][a-z\d+.-]*:/i.test(href)
    );
  }

  private getMimeType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'svg':
        return 'image/svg+xml';
      case 'webp':
        return 'image/webp';
      case 'avif':
        return 'image/avif';
      case 'woff':
        return 'font/woff';
      case 'woff2':
        return 'font/woff2';
      case 'ttf':
        return 'font/ttf';
      case 'otf':
        return 'font/otf';
      case 'pdf':
        return 'application/pdf';
      case 'json':
        return 'application/json';
      case 'jsonl':
        return 'application/x-ndjson';
      case 'usdz':
        return 'model/vnd.usdz+zip';
      case 'txt':
        return 'text/plain';
      default:
        return 'application/octet-stream';
    }
  }

  private localResource(ref: string, containingPath: string): { path: string; fragment: string } | null {
    try {
      const url = new URL(ref.trim(), `https://archive.invalid/${containingPath}`);
      const path = decodeURIComponent(url.pathname.slice(1));
      return url.origin === 'https://archive.invalid' && safePath(path) ? { path, fragment: url.hash } : null;
    } catch { return null; }
  }

  private async cssResource(zip: ZipContainer, ref: string, containingPath: string, cache: Map<string, string>): Promise<string> {
    if (!ref.trim() || ref.trim().startsWith('#') || /^data:/i.test(ref.trim())) return ref;
    const local = this.localResource(ref, containingPath);
    if (!local) return 'data:,';
    const entry = zip.file(local.path);
    if (!entry || entry.dir) return 'data:,';
    let url = cache.get(local.path);
    if (!url) {
      const bytes = await entry.async('uint8array') as Uint8Array;
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: this.getMimeType(local.path) }));
      cache.set(local.path, url); this.objectUrls.push(url);
    }
    return url + local.fragment;
  }

  private async replaceCss(text: string, pattern: RegExp, replace: (match: RegExpMatchArray) => Promise<string>): Promise<string> {
    const parts: string[] = []; let last = 0, size = 0;
    for (const match of text.matchAll(pattern)) {
      const prefix = text.slice(last, match.index), replacement = await replace(match);
      size += prefix.length + replacement.length;
      if (size > 30_000_000) throw new Error('Expanded stylesheet exceeds rendering limits.');
      parts.push(prefix, replacement); last = match.index! + match[0].length;
    }
    if (size + text.length - last > 30_000_000) throw new Error('Expanded stylesheet exceeds rendering limits.');
    return parts.join('') + text.slice(last);
  }

  private async resolveCss(zip: ZipContainer, text: string, containingPath: string, stack = new Set<string>(), budget = { imports: 0, urls: new Map<string, string>() }): Promise<string> {
    // Resolve against each containing stylesheet, never against the application URL.
    const imports = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|@import\s+(?:url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|"([^"]*)"|'([^']*)')\s*((?:[^;"']|"[^"]*"|'[^']*')*);/gi;
    const clean = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\*[\s\S]*?\*\//g, token => token.startsWith('/*') ? ' ' : token);
    const expanded = await this.replaceCss(clean, imports, async match => {
      if (match[0].startsWith('"') || match[0].startsWith("'")) return match[0];
      if (++budget.imports > 1000) throw new Error('Too many stylesheet imports.');
      const ref = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
      const local = this.localResource(ref, containingPath);
      if (!local || stack.has(local.path)) return '';
      const entry = zip.file(local.path);
      if (!entry || entry.dir) return '';
      if (stack.size >= 64) throw new Error('Stylesheet imports are too deeply nested.');
      const next = new Set(stack); next.add(local.path);
      const content = await this.resolveCss(zip, decodeUtf8(await entry.async('uint8array') as Uint8Array), local.path, next, budget);
      return this.wrapCssImport(content, (match[6] ?? '').trim());
    });
    // Imported CSS has already been resolved; its blob/data URLs must remain local.
    return this.replaceCss(expanded, /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, async match => {
      if (match[0].startsWith('"') || match[0].startsWith("'")) return match[0];
      const ref = match[1] ?? match[2] ?? match[3] ?? '';
      const url = ref.startsWith('blob:') && Array.from(budget.urls.values()).some(u => ref === u || ref.startsWith(u + '#')) ? ref : await this.cssResource(zip, ref, containingPath, budget.urls);
      return `url(${JSON.stringify(url)})`;
    });
  }

  private wrapCssImport(content: string, condition: string): string {
    let remaining = condition, layer: string | undefined, supports: string | undefined;
    const take = (name: string): string | undefined => {
      const start = new RegExp(`^${name}\\s*\\(`, 'i').exec(remaining);
      if (!start) return undefined;
      let depth = 1, quote = '';
      for (let i = start[0].length; i < remaining.length; i++) {
        const char = remaining[i];
        if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === '(') depth++;
        else if (char === ')' && --depth === 0) {
          const value = remaining.slice(start[0].length, i);
          remaining = remaining.slice(i + 1).trim(); return value;
        }
      }
      throw new Error('Invalid stylesheet import condition.');
    };
    layer = take('layer');
    if (layer === undefined && /^layer(?:\s|$)/i.test(remaining)) { layer = ''; remaining = remaining.slice(5).trim(); }
    supports = take('supports');
    if (remaining) content = `@media ${remaining} {${content}}`;
    if (supports !== undefined) content = `@supports (${supports}) {${content}}`;
    if (layer !== undefined) content = `@layer ${layer} {${content}}`;
    return content;
  }

  private async confirmExternalImageLoad(src: string): Promise<boolean> {
    const dialogRef = this.dialog.open(ExternalImageDialogComponent, {
      data: { src },
      restoreFocus: false,
    });

    try {
      return await firstValueFrom(dialogRef.afterClosed());
    } catch {
      return false;
    }
  }

  paginateContent = async (doc: Document, reservedHeight = 0): Promise<void> => {
    if (!this.paginationContainer) {
      console.warn('HtmlPageSplitter is not available; skipping pagination.');
      return;
    }

    const body = doc.body;
    const contentNodes = Array.from(body.childNodes).filter((node) => {
      return !(node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName.toLowerCase() === 'style');
    });

    if (contentNodes.length === 0) {
      return;
    }

    const contentHtml = contentNodes
      .map((node) =>
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element).outerHTML
          : node.textContent ?? '',
      )
      .join('');
    const pageWrapperTemplate = this.extractPageWrapperTemplate(contentNodes);
    contentNodes.forEach((node) => node.remove());

    const wdocContainer = doc.createElement('wdoc-container');
    body.appendChild(wdocContainer);

    const pages = this.documentLayoutEngineService.paginateBlocks(
      this.blockExtractorService.extractBlocksFromHtml(contentHtml, {
        contentWidth: DEFAULT_PAGE_WIDTH - DEFAULT_PAGE_PADDING * 2,
        defaultFont: DEFAULT_DOCUMENT_FONT,
        defaultLineHeight: DEFAULT_DOCUMENT_LINE_HEIGHT_PX,
        measurementRoot: this.paginationContainer,
      }),
      {
        measurementRoot: this.paginationContainer,
        pageHeight: Math.max(1, this.measuredPageHeight),
        pagePadding: DEFAULT_PAGE_PADDING,
        pageWidth: DEFAULT_PAGE_WIDTH,
        reservedBottom: Math.max(0, reservedHeight),
        reservedTop: 0,
      },
    );

    pages.forEach(({ html: pageHtml }) => {
      const page = doc.createElement('wdoc-page');
      page.innerHTML = pageWrapperTemplate
        ? this.wrapPageHtml(pageWrapperTemplate, pageHtml)
        : pageHtml;
      this.ensurePageContentContainer(page);
      wdocContainer.appendChild(page);
    });

    if (pages.length === 0) {
      const emptyPage = doc.createElement('wdoc-page');
      wdocContainer.appendChild(emptyPage);
    }
  };

  applyTemplatesToPages(
    doc: Document,
    templates: { headerTemplate: Element | null; footerTemplate: Element | null },
  ) {
    const { headerTemplate, footerTemplate } = templates;

    const pages = Array.from(doc.querySelectorAll('wdoc-page'));
    pages.forEach((page) => {
      const contentElement = this.ensurePageContentContainer(page);
      if (headerTemplate) {
        page.insertBefore(headerTemplate.cloneNode(true), contentElement);
      }
      if (footerTemplate) {
        page.appendChild(footerTemplate.cloneNode(true));
      }
      this.ensurePageContentContainer(page);
    });
  }

  cleanup(): void {
    if (this.paginationHost?.parentElement) {
      this.paginationHost.remove();
    }
    this.paginationHost = undefined;
    this.paginationContainer = undefined;
    this.paginationStyleEl = undefined;
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }

  private applyPaginationStyles(cssText: string) {
    if (typeof document === 'undefined') {
      return;
    }

    if (!this.paginationStyleEl || !this.paginationContainer) {
      const container = this.paginationContainer ?? this.createPaginationContainer();
      if (!this.paginationContainer && container) {
        this.paginationContainer = container;
      }
    }

    const styleTarget = this.paginationHost?.shadowRoot;
    if (!this.paginationStyleEl && styleTarget) {
      this.paginationStyleEl = document.createElement('style');
      this.paginationStyleEl.setAttribute('data-pagination-styles', 'true');
      styleTarget.prepend(this.paginationStyleEl);
    }

    if (this.paginationStyleEl) {
      this.paginationStyleEl.textContent = cssText;
    }

    if (this.paginationContainer) {
      const probePage = document.createElement('wdoc-page');
      probePage.style.visibility = 'hidden';
      probePage.style.position = 'absolute';
      probePage.style.pointerEvents = 'none';
      probePage.style.left = '0';
      probePage.style.top = '0';
      this.paginationContainer.appendChild(probePage);
      const measuredHeight = Math.ceil(probePage.getBoundingClientRect().height);
      this.paginationContainer.removeChild(probePage);
      if (measuredHeight > 0) {
        this.measuredPageHeight = measuredHeight;
      }
    }
  }

  private createPaginationContainer(): HTMLElement | undefined {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.visibility = 'hidden';
    host.style.pointerEvents = 'none';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = `${DEFAULT_PAGE_WIDTH}px`;
    host.style.padding = `${DEFAULT_PAGE_PADDING}px`;
    host.style.boxSizing = 'border-box';
    host.style.minHeight = `${DEFAULT_PAGE_HEIGHT}px`;
    host.style.height = 'auto';
    host.style.overflow = 'visible';
    host.style.zIndex = '-1';

    const shadowRoot = host.attachShadow({ mode: 'open' });
    this.paginationStyleEl = document.createElement('style');
    this.paginationStyleEl.setAttribute('data-pagination-styles', 'true');
    const container = document.createElement('body');

    shadowRoot.appendChild(this.paginationStyleEl);
    shadowRoot.appendChild(container);

    document.body.appendChild(host);
    this.paginationHost = host;
    return container;
  }

  private extractPageWrapperTemplate(nodes: ChildNode[]): HTMLElement | null {
    if (nodes.length !== 1) {
      return null;
    }

    const onlyNode = nodes[0];
    if (!(onlyNode instanceof HTMLElement)) {
      return null;
    }

    if (
      onlyNode.tagName.toLowerCase() !== 'div' ||
      !onlyNode.classList.contains('wdoc-document')
    ) {
      return null;
    }

    return onlyNode.cloneNode(false) as HTMLElement;
  }

  private wrapPageHtml(template: HTMLElement, innerHtml: string): string {
    const wrapper = template.cloneNode(false) as HTMLElement;
    wrapper.innerHTML = innerHtml;
    return wrapper.outerHTML;
  }

  private updateDocumentTitle(doc: Document, defaultTitle: string): string {
    const title = this.extractHeadTitle(doc);
    return title && title.length > 0 ? title : defaultTitle;
  }

  private extractHeadTitle(doc: Document): string | null {
    const headTitle = doc.querySelector('head title');
    const titleText = headTitle?.textContent?.trim();
    return titleText && titleText.length > 0 ? titleText : null;
  }

  private prepareTemplates(doc: Document): {
    headerTemplate: Element | null;
    footerTemplate: Element | null;
    headerHeight: number;
    footerHeight: number;
  } {
    const headerTemplate = this.extractTemplate(doc, 'wdoc-header');
    const footerTemplate = this.extractTemplate(doc, 'wdoc-footer');

    const headerHeight = headerTemplate ? this.measureTemplateHeight(headerTemplate) : 0;
    const footerHeight = footerTemplate ? this.measureTemplateHeight(footerTemplate) : 0;

    return { headerTemplate, footerTemplate, headerHeight, footerHeight };
  }

  private extractTemplate(doc: Document, selector: string): Element | null {
    const elements = Array.from(doc.querySelectorAll(selector));
    if (elements.length === 0) {
      return null;
    }
    const template = elements[0].cloneNode(true) as Element;
    elements.forEach((element) => element.remove());
    return template;
  }

  private measureTemplateHeight(template: Element): number {
    if (!this.paginationContainer) {
      return 0;
    }

    const wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.display = 'block';
    wrapper.appendChild(template.cloneNode(true));
    this.paginationContainer.appendChild(wrapper);
    const height = Math.ceil(wrapper.getBoundingClientRect().height);
    this.paginationContainer.removeChild(wrapper);
    return height;
  }

  private ensurePageContentContainer(page: Element): Element {
    const doc = page.ownerDocument;
    const headers = Array.from(page.querySelectorAll(':scope > wdoc-header'));
    const footers = Array.from(page.querySelectorAll(':scope > wdoc-footer'));
    let content = page.querySelector(':scope > wdoc-content') as Element | null;

    if (!content) {
      content = doc.createElement('wdoc-content');
    }

    const reservedElements = new Set<Element>([...headers, ...footers, content]);

    Array.from(page.childNodes).forEach((child) => {
      if (
        (child.nodeType === Node.ELEMENT_NODE && reservedElements.has(child as Element)) ||
        child === content
      ) {
        return;
      }
      content!.appendChild(child);
    });

    const fragment = doc.createDocumentFragment();
    headers.forEach((header) => fragment.appendChild(header));
    fragment.appendChild(content);
    footers.forEach((footer) => fragment.appendChild(footer));

    page.appendChild(fragment);

    return content;
  }

  private applyPageMetadata(doc: Document): void {
    const container = doc.querySelector('wdoc-container');
    const targetRoots = container ? [container] : [doc.body];
    const pages = targetRoots.flatMap((root) =>
      Array.from(root.querySelectorAll('wdoc-page')).filter((page) => page.parentElement === root),
    );
    const totalPages = pages.length;
    const now = new Date();

    pages.forEach((page, index) => {
      const pageNumber = (index + 1).toString();
      this.replacePlaceholders(page, 'wdoc-pagenum', pageNumber, page.ownerDocument || doc);
      this.replacePlaceholders(
        page,
        'wdoc-nbpages',
        totalPages.toString(),
        page.ownerDocument || doc,
      );
      this.replaceDatePlaceholders(page, now, page.ownerDocument || doc);
    });
  }

  private replacePlaceholders(
    container: Element,
    selector: string,
    text: string,
    doc: Document,
  ): void {
    const placeholders = Array.from(container.querySelectorAll(selector));
    placeholders.forEach((el) => {
      el.textContent = text;
    });
  }

  private replaceDatePlaceholders(page: Element, date: Date, doc: Document): void {
    const placeholders = Array.from(page.querySelectorAll('wdoc-date'));
    placeholders.forEach((el) => {
      const format = el.getAttribute('format') || undefined;
      const formatted = this.formatDate(date, format);
      el.textContent = formatted;
    });
  }

  private async renderBarcodes(doc: Document): Promise<void> {
    const barcodes = Array.from(doc.querySelectorAll('wdoc-barcode'));
    for (const barcode of barcodes) {
      const value = barcode.textContent?.trim();
      if (!value) {
        barcode.replaceWith(doc.createTextNode(''));
        continue;
      }

      barcode.setAttribute('text', value);
      const type = (barcode.getAttribute('type') || 'qrcode').toLowerCase();
      if (type === 'qrcode') {
        await this.renderQrCode(barcode, value, doc);
        continue;
      }

      await this.renderLinearBarcode(barcode, value, type, doc);
    }
  }

  private async renderQrCode(barcode: Element, value: string, doc: Document): Promise<void> {
    const errorCorrection = this.normalizeErrorCorrectionLevel(barcode.getAttribute('errorcorrection'));
    try {
      const dataUrl = await this.generateQrCodeDataUrl(value, {
        errorCorrectionLevel: errorCorrection,
      });

      const img = doc.createElement('img');
      img.setAttribute('src', dataUrl);
      img.setAttribute('alt', '');
      img.style.width = '100%';

      img.setAttribute('aria-label', barcode.getAttribute('aria-label') || 'QR code');

      barcode.innerHTML = '';
      barcode.appendChild(img);
    } catch (error) {
      console.error('Error generating QR code:', error);
      barcode.replaceWith(doc.createTextNode(value));
    }
  }

  private async renderLinearBarcode(
    barcode: Element,
    value: string,
    type: string,
    doc: Document,
  ): Promise<void> {
    const normalizedType = this.normalizeLinearBarcodeType(type);
    if (!normalizedType) {
      return;
    }

    const svgNamespace = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('aria-label', barcode.getAttribute('aria-label') || 'Barcode');
    svg.setAttribute('role', 'img');

    this.copyCssAttributes(barcode, svg);

    try {
      this.generateLinearBarcode(svg, value, normalizedType);
      barcode.innerHTML = '';
      barcode.appendChild(svg);
    } catch (error) {
      console.error('Error generating linear barcode:', error);
      barcode.replaceWith(doc.createTextNode(value));
    }
  }

  private copyCssAttributes(source: Element, target: Element): void {
    const attributesToCopy = ['class', 'style', 'height', 'width', 'aria-label', 'aria-describedby'];

    attributesToCopy.forEach((attr) => {
      const value = source.getAttribute(attr);
      if (value !== null) {
        target.setAttribute(attr, value);
      }
    });
  }

  private generateLinearBarcode(target: SVGElement, value: string, format: string): void {
    JsBarcode(target, value, { format });
  }

  private generateQrCodeDataUrl(
    value: string,
    options: QRCodeToDataURLOptions,
  ): Promise<string> {
    return QRCode.toDataURL(value, options);
  }

  private normalizeLinearBarcodeType(type: string): string | null {
    const normalized = type.toLowerCase();
    if (this.barcodeTypes.has(normalized)) {
      return normalized.toUpperCase();
    }
    return null;
  }

  private normalizeErrorCorrectionLevel(level: string | null): QRCodeToDataURLOptions['errorCorrectionLevel'] {
    const normalized = (level || 'M').toUpperCase();
    if (['L', 'M', 'Q', 'H'].includes(normalized)) {
      return normalized as QRCodeToDataURLOptions['errorCorrectionLevel'];
    }
    return 'M';
  }

  private formatDate(date: Date, format = 'dd/mm/YYYY'): string {
    const year = date.getFullYear().toString();
    const month = this.padWithZero(date.getMonth() + 1);
    const day = this.padWithZero(date.getDate());

    let result = format;
    result = result.replace(/YYYY/g, year);
    result = result.replace(/Y/g, year);
    result = result.replace(/MM/g, month);
    result = result.replace(/mm/g, month);
    result = result.replace(/DD/g, day);
    result = result.replace(/dd/g, day);
    return result;
  }

  private padWithZero(value: number): string {
    return value.toString().padStart(2, '0');
  }
}
