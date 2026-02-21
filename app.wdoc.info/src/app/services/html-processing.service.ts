import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom, firstValueFrom } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import DOMPurify from 'dompurify';
import { HtmlPageSplitter } from '../pagination/html-pages/HtmlPageSplitter';
import { FormManagerService } from './form-manager.service';
import QRCode from 'qrcode';
import { QRCodeToDataURLOptions } from 'qrcode';
import JsBarcode from 'jsbarcode';
import { ExternalImageDialogComponent } from './external-image-dialog.component';
import { type ZipContainer } from './zip-reader';

interface ProcessHtmlOptions {
  defaultTitle?: string;
}

@Injectable({ providedIn: 'root' })
export class HtmlProcessingService {
  private paginationStyleEl?: HTMLStyleElement;
  private paginationHost?: HTMLElement;
  private htmlPageSplitter?: HtmlPageSplitter;
  private paginationContainer?: HTMLElement;
  private objectUrls: string[] = [];
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
  ) {
    if (typeof document !== 'undefined') {
      this.paginationContainer = this.createPaginationContainer();
      if (this.paginationContainer) {
        this.htmlPageSplitter = new HtmlPageSplitter({
          container: this.paginationContainer,
          pageHeight: 1122,
        });
      }
    }
  }

  async processHtml(
    zip: ZipContainer,
    html: string,
    options: ProcessHtmlOptions = {},
  ): Promise<{ html: string; documentTitle: string }> {
    const sanitizedHtml = this.sanitizeHtml(html);
    const parser = new DOMParser();
    const doc = parser.parseFromString(sanitizedHtml, 'text/html');
    const documentTitle = this.updateDocumentTitle(
      doc,
      options.defaultTitle ?? 'WDOC viewer',
    );

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

      const normalizedSrc = src.startsWith('/') ? src.slice(1) : src;
      const fileInZip = zip.file(normalizedSrc);
      if (fileInZip) {
        try {
          const blobContent = (await fileInZip.async('blob')) as Blob;
          const ext = normalizedSrc.split('.').pop()?.toLowerCase();
          let mime = 'image/png';
          if (ext === 'jpg' || ext === 'jpeg') {
            mime = 'image/jpeg';
          } else if (ext === 'gif') {
            mime = 'image/gif';
          } else if (ext === 'svg') {
            mime = 'image/svg+xml';
          }
          const typedBlob = new Blob([blobContent], { type: mime });
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

    let combinedCSS = '';

    const headStyleEls = Array.from(doc.head.querySelectorAll('style'));
    headStyleEls.forEach((el) => {
      if (el.textContent) {
        combinedCSS += el.textContent + '\n';
      }
    });

    const headLinkEls = Array.from(doc.head.querySelectorAll('link[rel="stylesheet"]'));
    for (const linkEl of headLinkEls) {
      const href = linkEl.getAttribute('href');
      if (href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('data:')) {
        const normalizedHref = href.startsWith('/') ? href.slice(1) : href;
        const cssFile = zip.file(normalizedHref);
        if (cssFile) {
          try {
            const cssContent = (await cssFile.async('text')) as string;
            combinedCSS += cssContent + '\n';
          } catch (error) {
            console.error(`Error loading internal CSS file ${normalizedHref}:`, error);
          }
        }
      }
    }

    try {
      const externalCSS = await lastValueFrom(
        this.http.get('assets/wdoc-styles.css', { responseType: 'text' }),
      );
      combinedCSS += externalCSS + '\n';
    } catch (error) {
      console.error('Error loading external CSS:', error);
    }

    this.applyPaginationStyles(combinedCSS);

    if (doc.head) {
      doc.head.remove();
    }

    const newStyleEl = doc.createElement('style');
    newStyleEl.textContent = combinedCSS;
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

    await this.formManagerService.populateFormsFromZip(zip, doc);
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
    return src.startsWith('http') || src.startsWith('//') || src.startsWith('data:');
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
    if (!this.htmlPageSplitter) {
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

    const wrapper = doc.createElement('div');
    contentNodes.forEach((node) => {
      wrapper.appendChild(node.cloneNode(true));
      node.remove();
    });

    const wdocContainer = doc.createElement('wdoc-container');
    body.appendChild(wdocContainer);

    let hasPages = false;
    const adjustedHeight = Math.max(
      1,
      (this.htmlPageSplitter.defaultOptions.pageHeight ?? 1122) - Math.max(0, reservedHeight),
    );

    if (this.paginationContainer) {
      this.paginationContainer.style.minHeight = `${adjustedHeight}px`;
    }

    for await (const pageHtml of this.htmlPageSplitter.split(wrapper.innerHTML, {
      pageHeight: adjustedHeight,
    })) {
      const trimmed = pageHtml.trim();
      if (!trimmed) {
        continue;
      }
      const page = doc.createElement('wdoc-page');
      page.innerHTML = pageHtml;
      this.ensurePageContentContainer(page);
      wdocContainer.appendChild(page);
      hasPages = true;
    }

    if (!hasPages) {
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
    this.htmlPageSplitter?.abort();
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
        this.htmlPageSplitter = new HtmlPageSplitter({
          ...this.htmlPageSplitter?.defaultOptions,
          container: this.paginationContainer,
          pageHeight: measuredHeight,
        });
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
    host.style.width = '793.8px';
    host.style.padding = '20px';
    host.style.boxSizing = 'border-box';
    host.style.minHeight = '1122px';
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
    const footers = Array.from(page.querySelectorAll(':scope > wdoc-footer, :scope > doc-footer'));
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
