import { Injectable } from '@angular/core';
import { TextLayoutService } from './text-layout.service';
import {
  type DocumentBlock,
  type ListContainerMeta,
  type PaginatedPage,
  type PaginationConstraints,
} from './layout.types';

type TextFragmentRange = {
  endOffset: number;
  endRawOffset: number;
  startOffset: number;
  startRawOffset: number;
};

type FragmentState = {
  block: DocumentBlock;
  layoutLines: string[];
  lineRanges: TextFragmentRange[];
  nextLineIndex: number;
};

@Injectable({ providedIn: 'root' })
export class DocumentLayoutEngineService {
  constructor(private textLayoutService: TextLayoutService) {}

  paginateBlocks(
    blocks: DocumentBlock[],
    constraints: PaginationConstraints,
  ): PaginatedPage[] {
    const pages: DocumentBlock[][] = [[]];
    const contentWidth = this.getContentWidth(constraints);
    const pageHeight = this.getAvailableHeight(constraints);
    let remainingHeight = pageHeight;
    let currentPage = pages[0];

    for (const block of blocks) {
      if (
        block.atomic ||
        !block.text ||
        block.kind === 'raw-html-block' ||
        block.kind === 'image-block' ||
        block.kind === 'barcode-block'
      ) {
        if (
          currentPage.length > 0 &&
          (block.measuredHeight ?? 0) > remainingHeight
        ) {
          currentPage = [];
          pages.push(currentPage);
          remainingHeight = pageHeight;
        }

        currentPage.push(block);
        remainingHeight -= block.measuredHeight ?? 0;
        continue;
      }

      const fragmentState = this.buildFragmentState(block, contentWidth);
      while (fragmentState.nextLineIndex < fragmentState.layoutLines.length) {
        const fragment = this.takeNextFragment(
          fragmentState,
          remainingHeight,
          currentPage.length === 0,
        );

        if (!fragment) {
          currentPage = [];
          pages.push(currentPage);
          remainingHeight = pageHeight;
          continue;
        }

        currentPage.push(fragment);
        remainingHeight -= fragment.measuredHeight ?? 0;

        if (fragmentState.nextLineIndex < fragmentState.layoutLines.length) {
          currentPage = [];
          pages.push(currentPage);
          remainingHeight = pageHeight;
        }
      }
    }

    return pages.map((pageBlocks) => ({
      blocks: pageBlocks,
      html: this.renderPageBlocks(pageBlocks),
    }));
  }

  private buildFragmentState(
    block: DocumentBlock,
    contentWidth: number,
  ): FragmentState {
    const text = block.text ?? '';
    const layout = this.textLayoutService.layoutTextLines(
      text,
      block.font,
      block.lineHeight,
      contentWidth,
      block.whiteSpace,
    );
    const layoutLines = layout.lines.map((line) => line.text);
    const lineRanges = this.resolveLineRanges(text, layoutLines);

    return {
      block,
      layoutLines,
      lineRanges,
      nextLineIndex: 0,
    };
  }

  private takeNextFragment(
    state: FragmentState,
    remainingHeight: number,
    forceAtLeastOneLine: boolean,
  ): DocumentBlock | null {
    const { block, lineRanges, layoutLines, nextLineIndex } = state;
    if (nextLineIndex >= layoutLines.length) {
      return null;
    }

    const isFirstFragment = nextLineIndex === 0;
    const marginTop = isFirstFragment ? block.marginTop : 0;
    const availableForLines = remainingHeight - block.chromeHeight - marginTop;
    let lineCount = Math.floor(availableForLines / block.lineHeight);

    if (forceAtLeastOneLine) {
      lineCount = Math.max(1, lineCount);
    }

    if (lineCount <= 0) {
      return null;
    }

    let endLineIndex = Math.min(layoutLines.length, nextLineIndex + lineCount);
    while (endLineIndex > nextLineIndex) {
      const isLastFragment = endLineIndex === layoutLines.length;
      const fragmentHeight =
        block.chromeHeight +
        (endLineIndex - nextLineIndex) * block.lineHeight +
        marginTop +
        (isLastFragment ? block.marginBottom : 0);

      if (fragmentHeight <= remainingHeight || forceAtLeastOneLine) {
        const startRange = lineRanges[nextLineIndex];
        const endRange = lineRanges[endLineIndex - 1];
        const html = this.sliceBlockHtml(
          block.html,
          startRange.startRawOffset,
          endRange.endRawOffset,
          !isFirstFragment,
          !isLastFragment,
        );

        state.nextLineIndex = endLineIndex;

        return {
          ...block,
          html,
          id: `${block.id}-fragment-${nextLineIndex}`,
          marginBottom: isLastFragment ? block.marginBottom : 0,
          marginTop,
          measuredHeight: fragmentHeight,
          text: block.text?.slice(
            startRange.startOffset,
            endRange.endOffset,
          ),
        };
      }

      endLineIndex -= 1;
      forceAtLeastOneLine = false;
    }

    return null;
  }

  private resolveLineRanges(
    rawText: string,
    lines: string[],
  ): TextFragmentRange[] {
    let searchCursor = 0;
    let normalizedCursor = 0;

    return lines.map((line) => {
      const startRawOffset =
        line.length === 0 ? searchCursor : rawText.indexOf(line, searchCursor);
      const safeStartRawOffset =
        startRawOffset >= 0 ? startRawOffset : searchCursor;
      const endRawOffset = safeStartRawOffset + line.length;
      const range: TextFragmentRange = {
        endOffset: normalizedCursor + line.length,
        endRawOffset,
        startOffset: normalizedCursor,
        startRawOffset: safeStartRawOffset,
      };

      searchCursor = endRawOffset;
      while (searchCursor < rawText.length && rawText[searchCursor] === '\n') {
        searchCursor += 1;
      }
      normalizedCursor = range.endOffset;
      return range;
    });
  }

  private sliceBlockHtml(
    html: string,
    startOffset: number,
    endOffset: number,
    removeTopMargin: boolean,
    removeBottomMargin: boolean,
  ): string {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();
    const root = wrapper.firstElementChild;
    if (!root) {
      return html;
    }

    const slicedRoot = this.cloneNodeInRange(
      root,
      { value: 0 },
      startOffset,
      endOffset,
    ) as HTMLElement | null;
    if (!slicedRoot) {
      return html;
    }

    if (removeTopMargin || removeBottomMargin) {
      const style = slicedRoot.getAttribute('style');
      const appended = [
        style?.trim(),
        removeTopMargin ? 'margin-top: 0 !important' : '',
        removeBottomMargin ? 'margin-bottom: 0 !important' : '',
      ]
        .filter(Boolean)
        .join('; ');

      slicedRoot.setAttribute('style', appended);
    }

    return slicedRoot.outerHTML;
  }

  private cloneNodeInRange(
    node: Node,
    cursor: { value: number },
    startOffset: number,
    endOffset: number,
  ): Node | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? '';
      const nextCursor = cursor.value + value.length;
      const start = Math.max(0, startOffset - cursor.value);
      const end = Math.min(value.length, endOffset - cursor.value);
      cursor.value = nextCursor;

      if (end <= start) {
        return null;
      }

      return document.createTextNode(value.slice(start, end));
    }

    if (!(node instanceof HTMLElement)) {
      return null;
    }

    if (node.tagName.toLowerCase() === 'br') {
      const lineBreakPosition = cursor.value;
      cursor.value += 1;
      if (
        lineBreakPosition < startOffset ||
        lineBreakPosition >= endOffset
      ) {
        return null;
      }
      return node.cloneNode(false);
    }

    const clone = node.cloneNode(false) as HTMLElement;
    Array.from(node.childNodes).forEach((child) => {
      const slicedChild = this.cloneNodeInRange(
        child,
        cursor,
        startOffset,
        endOffset,
      );
      if (slicedChild) {
        clone.appendChild(slicedChild);
      }
    });

    if (clone.childNodes.length === 0) {
      return null;
    }

    return clone;
  }

  private renderPageBlocks(blocks: DocumentBlock[]): string {
    const wrapper = document.createElement('div');
    let currentList: {
      meta: ListContainerMeta;
      items: string[];
    } | null = null;

    const flushList = () => {
      if (!currentList) {
        return;
      }

      wrapper.appendChild(this.buildListElement(currentList.meta, currentList.items));
      currentList = null;
    };

    blocks.forEach((block) => {
      if (block.kind === 'list-block' && block.listMeta) {
        if (
          currentList &&
          this.areSameList(currentList.meta, block.listMeta)
        ) {
          currentList.items.push(block.html);
          return;
        }

        flushList();
        currentList = {
          items: [block.html],
          meta: block.listMeta,
        };
        return;
      }

      flushList();
      wrapper.appendChild(this.parseElement(block.html));
    });

    flushList();
    return wrapper.innerHTML;
  }

  private buildListElement(
    meta: ListContainerMeta,
    itemHtml: string[],
  ): HTMLElement {
    const list = document.createElement(meta.tagName);
    Object.entries(meta.attrs).forEach(([name, value]) => {
      list.setAttribute(name, value);
    });

    if (meta.tagName === 'ol' && meta.itemIndex !== 1) {
      list.setAttribute('start', `${meta.itemIndex}`);
    }

    itemHtml.forEach((html) => {
      list.appendChild(this.parseElement(html));
    });

    return list;
  }

  private parseElement(html: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();
    return (wrapper.firstElementChild as HTMLElement) ?? document.createElement('div');
  }

  private areSameList(left: ListContainerMeta, right: ListContainerMeta): boolean {
    return (
      left.tagName === right.tagName &&
      JSON.stringify(left.attrs) === JSON.stringify(right.attrs) &&
      (left.tagName !== 'ol' || left.itemIndex + 1 === right.itemIndex)
    );
  }

  private getContentWidth(constraints: PaginationConstraints): number {
    return Math.max(1, constraints.pageWidth - constraints.pagePadding * 2);
  }

  private getAvailableHeight(constraints: PaginationConstraints): number {
    return Math.max(
      1,
      constraints.pageHeight -
        constraints.pagePadding * 2 -
        constraints.reservedTop -
        constraints.reservedBottom,
    );
  }
}
