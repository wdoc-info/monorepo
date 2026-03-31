import { Injectable } from '@angular/core';
import {
  clearCache,
  layout,
  layoutWithLines,
  prepare,
  prepareWithSegments,
  setLocale,
  type LayoutLinesResult,
  type PreparedText,
  type PreparedTextWithSegments,
} from '@chenglou/pretext';
import { type SupportedWhiteSpace } from './layout.types';

type PreparedCacheEntry = {
  prepared: PreparedText;
  preparedWithSegments: PreparedTextWithSegments;
};

@Injectable({ providedIn: 'root' })
export class TextLayoutService {
  private preparedCache = new Map<string, PreparedCacheEntry>();
  private locale?: string;

  setLocale(locale?: string): void {
    if (this.locale === locale) {
      return;
    }

    this.locale = locale;
    setLocale(locale);
    clearCache();
    this.preparedCache.clear();
  }

  measureText(
    text: string,
    font: string,
    lineHeight: number,
    width: number,
    whiteSpace: SupportedWhiteSpace = 'normal',
  ): { height: number; lineCount: number } {
    const prepared = this.getPrepared(text, font, whiteSpace).prepared;
    return layout(prepared, width, lineHeight);
  }

  layoutTextLines(
    text: string,
    font: string,
    lineHeight: number,
    width: number,
    whiteSpace: SupportedWhiteSpace = 'normal',
  ): LayoutLinesResult {
    const prepared = this.getPrepared(text, font, whiteSpace)
      .preparedWithSegments;
    return layoutWithLines(prepared, width, lineHeight);
  }

  private getPrepared(
    text: string,
    font: string,
    whiteSpace: SupportedWhiteSpace,
  ): PreparedCacheEntry {
    const key = JSON.stringify([
      this.locale ?? '',
      font,
      whiteSpace,
      text,
    ]);
    const cached = this.preparedCache.get(key);
    if (cached) {
      return cached;
    }

    const options = { whiteSpace };
    const entry: PreparedCacheEntry = {
      prepared: prepare(text, font, options),
      preparedWithSegments: prepareWithSegments(text, font, options),
    };
    this.preparedCache.set(key, entry);
    return entry;
  }
}
