import { Injectable } from '@angular/core';
import { TextLayoutService } from './text-layout.service';
import {
  type BlockExtractionOptions,
  type DocumentBlock,
  type DocumentBlockKind,
  type ListContainerMeta,
  type SupportedWhiteSpace,
} from './layout.types';

const ALLOWED_INLINE_TAGS = new Set([
  'a',
  'b',
  'br',
  'code',
  'em',
  'i',
  'mark',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'u',
  'wdoc-date',
  'wdoc-nbpages',
  'wdoc-pagenum',
]);

const TEXT_BLOCK_TAGS = new Set([
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
]);

@Injectable({ providedIn: 'root' })
export class BlockExtractorService {
  private blockCounter = 0;

  constructor(private textLayoutService: TextLayoutService) {}

  extractBlocksFromHtml(
    html: string,
    options: BlockExtractionOptions,
  ): DocumentBlock[] {
    const wrapper = this.createMeasurementWrapper(options);
    wrapper.innerHTML = html || '<p></p>';
    options.measurementRoot.appendChild(wrapper);

    try {
      const blocks = this.extractBlocksFromWrapper(wrapper, options);
      if (blocks.length) {
        return blocks;
      }

      return [
        this.buildAtomicBlock(
          this.ensureParagraph(wrapper.ownerDocument, '<p></p>'),
          'raw-html-block',
          options,
        ),
      ];
    } finally {
      wrapper.remove();
    }
  }

  private extractBlocksFromWrapper(
    wrapper: HTMLElement,
    options: BlockExtractionOptions,
  ): DocumentBlock[] {
    const blocks: DocumentBlock[] = [];

    Array.from(wrapper.childNodes).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent?.trim();
        if (!text) {
          return;
        }

        const paragraph = this.ensureParagraph(wrapper.ownerDocument, text);
        wrapper.appendChild(paragraph);
        blocks.push(...this.extractBlocksFromElement(paragraph, options));
        paragraph.remove();
        return;
      }

      if (!(child instanceof HTMLElement)) {
        return;
      }

      blocks.push(...this.extractBlocksFromElement(child, options));
    });

    return blocks;
  }

  private extractBlocksFromElement(
    element: HTMLElement,
    options: BlockExtractionOptions,
  ): DocumentBlock[] {
    const tagName = element.tagName.toLowerCase();

    if (tagName === 'ul' || tagName === 'ol') {
      return this.extractListBlocks(element, options);
    }

    const kind = this.detectKind(element);
    if (this.isTextCompatible(element) && this.matchesPretextPolicy(element)) {
      return [this.buildTextBlock(element, kind, options)];
    }

    return [
      this.buildAtomicBlock(
        element,
        kind === 'list-block' ? kind : 'raw-html-block',
        options,
      ),
    ];
  }

  private extractListBlocks(
    list: HTMLElement,
    options: BlockExtractionOptions,
  ): DocumentBlock[] {
    const tagName = list.tagName.toLowerCase() as 'ol' | 'ul';
    const baseIndex =
      tagName === 'ol' ? Number(list.getAttribute('start') || '1') : 1;
    const attrs = this.getElementAttributes(list, ['start']);
    const items = Array.from(list.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );

    return items.flatMap((item, index) => {
      const listMeta: ListContainerMeta = {
        attrs,
        itemIndex: baseIndex + index,
        tagName,
      };

      if (this.isTextCompatible(item) && this.matchesPretextPolicy(item)) {
        return [
          this.buildTextBlock(item, 'list-block', options, listMeta),
        ];
      }

      return [
        this.buildAtomicBlock(item, 'list-block', options, listMeta),
      ];
    });
  }

  private buildTextBlock(
    element: HTMLElement,
    kind: DocumentBlockKind,
    options: BlockExtractionOptions,
    listMeta?: ListContainerMeta,
  ): DocumentBlock {
    const style = getComputedStyle(element);
    const whiteSpace = this.resolveWhiteSpace(
      style.whiteSpace,
      options.fallbackWhiteSpace ?? 'normal',
    );
    const text = this.extractTextForLayout(element) || ' ';
    const font = this.composeFontShorthand(style, options.defaultFont);
    const lineHeight = this.resolveLineHeight(style, options.defaultLineHeight);
    const metrics = this.textLayoutService.measureText(
      text,
      font,
      lineHeight,
      options.contentWidth,
      whiteSpace,
    );

    const boxHeight = element.getBoundingClientRect().height;
    const chromeHeight = Math.max(0, boxHeight - metrics.height);
    const marginTop = this.parsePixelValue(style.marginTop);
    const marginBottom = this.parsePixelValue(style.marginBottom);

    return {
      atomic: false,
      chromeHeight,
      font,
      html: element.outerHTML,
      id: this.nextBlockId(kind),
      kind,
      lineCount: metrics.lineCount,
      lineHeight,
      listMeta,
      marginBottom,
      marginTop,
      measuredHeight: chromeHeight + metrics.height + marginTop + marginBottom,
      text,
      whiteSpace,
    };
  }

  private buildAtomicBlock(
    element: HTMLElement,
    kind: DocumentBlockKind,
    options: BlockExtractionOptions,
    listMeta?: ListContainerMeta,
  ): DocumentBlock {
    const style = getComputedStyle(element);
    const marginTop = this.parsePixelValue(style.marginTop);
    const marginBottom = this.parsePixelValue(style.marginBottom);
    const measuredHeight =
      element.getBoundingClientRect().height + marginTop + marginBottom;

    return {
      atomic: true,
      chromeHeight: Math.max(0, measuredHeight - marginTop - marginBottom),
      font: this.composeFontShorthand(style, options.defaultFont),
      html: element.outerHTML,
      id: this.nextBlockId(kind),
      kind,
      lineHeight: this.resolveLineHeight(style, options.defaultLineHeight),
      listMeta,
      marginBottom,
      marginTop,
      measuredHeight,
      whiteSpace: this.resolveWhiteSpace(
        style.whiteSpace,
        options.fallbackWhiteSpace ?? 'normal',
      ),
    };
  }

  private createMeasurementWrapper(
    options: BlockExtractionOptions,
  ): HTMLElement {
    const wrapper = options.measurementRoot.ownerDocument.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.visibility = 'hidden';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.left = '0';
    wrapper.style.top = '0';
    wrapper.style.width = `${options.contentWidth}px`;
    wrapper.style.padding = '0';
    wrapper.style.boxSizing = 'border-box';
    wrapper.style.font = options.defaultFont;
    wrapper.style.lineHeight = `${options.defaultLineHeight}px`;
    wrapper.style.wordBreak = 'normal';
    wrapper.style.overflowWrap = 'break-word';
    wrapper.style.whiteSpace = options.fallbackWhiteSpace ?? 'normal';
    return wrapper;
  }

  private matchesPretextPolicy(element: HTMLElement): boolean {
    const style = getComputedStyle(element);
    const whiteSpace = style.whiteSpace;
    const wordBreak = style.wordBreak;
    const overflowWrap = style.overflowWrap;
    const fontFamily = style.fontFamily.toLowerCase();

    return (
      (whiteSpace === 'normal' || whiteSpace === 'pre-wrap') &&
      wordBreak === 'normal' &&
      overflowWrap === 'break-word' &&
      !fontFamily.includes('system-ui')
    );
  }

  private isTextCompatible(element: HTMLElement): boolean {
    const tagName = element.tagName.toLowerCase();
    if (!TEXT_BLOCK_TAGS.has(tagName)) {
      return false;
    }

    return !this.hasUnsupportedDescendants(element);
  }

  private hasUnsupportedDescendants(element: HTMLElement): boolean {
    const descendants = Array.from(element.querySelectorAll('*'));
    return descendants.some((descendant) => {
      const tagName = descendant.tagName.toLowerCase();
      return !ALLOWED_INLINE_TAGS.has(tagName);
    });
  }

  private detectKind(element: HTMLElement): DocumentBlockKind {
    const tagName = element.tagName.toLowerCase();
    if (tagName.startsWith('h')) {
      return 'heading-block';
    }
    if (tagName === 'img') {
      return 'image-block';
    }
    if (tagName === 'wdoc-barcode') {
      return 'barcode-block';
    }
    if (tagName === 'li') {
      return 'list-block';
    }
    if (TEXT_BLOCK_TAGS.has(tagName)) {
      return 'text-block';
    }
    return 'raw-html-block';
  }

  private extractTextForLayout(element: HTMLElement): string {
    const chunks: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        chunks.push(node.textContent ?? '');
        return;
      }

      if (!(node instanceof HTMLElement)) {
        return;
      }

      if (node.tagName.toLowerCase() === 'br') {
        chunks.push('\n');
        return;
      }

      Array.from(node.childNodes).forEach((child) => walk(child));
    };

    Array.from(element.childNodes).forEach((child) => walk(child));
    return chunks.join('');
  }

  private composeFontShorthand(
    style: CSSStyleDeclaration,
    fallbackFont: string,
  ): string {
    if (style.font) {
      return style.font;
    }

    const fontStyle = style.fontStyle || 'normal';
    const fontVariant = style.fontVariant || 'normal';
    const fontWeight = style.fontWeight || '400';
    const fontSize = style.fontSize || fallbackFont;
    const fontFamily = style.fontFamily || fallbackFont;
    return `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
  }

  private resolveLineHeight(
    style: CSSStyleDeclaration,
    fallback: number,
  ): number {
    const parsed = this.parsePixelValue(style.lineHeight);
    if (parsed > 0) {
      return parsed;
    }

    const fontSize = this.parsePixelValue(style.fontSize);
    if (fontSize > 0) {
      return fontSize * 1.2;
    }

    return fallback;
  }

  private resolveWhiteSpace(
    value: string,
    fallback: SupportedWhiteSpace,
  ): SupportedWhiteSpace {
    return value === 'pre-wrap' ? 'pre-wrap' : fallback;
  }

  private getElementAttributes(
    element: HTMLElement,
    exclude: string[] = [],
  ): Record<string, string> {
    const ignored = new Set(exclude);
    return Array.from(element.attributes).reduce<Record<string, string>>(
      (attrs, attribute) => {
        if (!ignored.has(attribute.name)) {
          attrs[attribute.name] = attribute.value;
        }
        return attrs;
      },
      {},
    );
  }

  private parsePixelValue(value: string | null | undefined): number {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private ensureParagraph(documentRef: Document, text: string): HTMLElement {
    const paragraph = documentRef.createElement('p');
    paragraph.textContent = text;
    return paragraph;
  }

  private nextBlockId(kind: DocumentBlockKind): string {
    this.blockCounter += 1;
    return `${kind}-${this.blockCounter}`;
  }
}
