export type SupportedWhiteSpace = 'normal' | 'pre-wrap';

export type DocumentBlockKind =
  | 'text-block'
  | 'heading-block'
  | 'list-block'
  | 'image-block'
  | 'barcode-block'
  | 'raw-html-block';

export interface PaginationConstraints {
  measurementRoot?: HTMLElement;
  pageWidth: number;
  pageHeight: number;
  pagePadding: number;
  reservedTop: number;
  reservedBottom: number;
}

export interface ListContainerMeta {
  attrs: Record<string, string>;
  itemIndex: number;
  tagName: 'ol' | 'ul';
}

export interface DocumentBlock {
  atomic: boolean;
  chromeHeight: number;
  font: string;
  html: string;
  id: string;
  kind: DocumentBlockKind;
  lineCount?: number;
  lineHeight: number;
  listMeta?: ListContainerMeta;
  marginBottom: number;
  marginTop: number;
  measuredHeight?: number;
  text?: string;
  whiteSpace: SupportedWhiteSpace;
}

export interface PaginatedPage {
  blocks: DocumentBlock[];
  html: string;
}

export interface BlockExtractionOptions {
  contentWidth: number;
  defaultFont: string;
  defaultLineHeight: number;
  fallbackWhiteSpace?: SupportedWhiteSpace;
  measurementRoot: HTMLElement;
}
