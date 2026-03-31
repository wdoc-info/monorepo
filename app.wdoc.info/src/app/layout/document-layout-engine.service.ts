import { Injectable } from '@angular/core';
import { TextLayoutService } from './text-layout.service';
import {
  type DocumentBlock,
  type ListContainerMeta,
  type PaginatedPage,
  type PaginationConstraints,
} from './layout.types';

const BREAKING_SPACE_CHARACTERS =
  ' \u2002\u2003\u2004\u2005\u2006\u2008\u2009\u200A\u200B';

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

type BlockSplitResult = {
  fittingBlock: DocumentBlock;
  remainderBlock: DocumentBlock;
};

@Injectable({ providedIn: 'root' })
export class DocumentLayoutEngineService {
  private fragmentCounter = 0;

  constructor(private textLayoutService: TextLayoutService) {}

  paginateBlocks(
    blocks: DocumentBlock[],
    constraints: PaginationConstraints,
  ): PaginatedPage[] {
    const pages: DocumentBlock[][] = [[]];
    const contentWidth = this.getContentWidth(constraints);
    const pageHeight = this.getAvailableHeight(constraints);
    let usedHeight = 0;
    let currentPage = pages[0];
    const queue = [...blocks];

    while (queue.length > 0) {
      const block = queue.shift() as DocumentBlock;
      if (
        block.atomic ||
        !block.text ||
        block.kind === 'raw-html-block' ||
        block.kind === 'image-block' ||
        block.kind === 'barcode-block'
      ) {
        const previousBlock = currentPage[currentPage.length - 1];
        const heightIncrement = this.getHeightIncrement(
          block,
          previousBlock,
        );

        if (usedHeight + heightIncrement > pageHeight) {
          const splitResult = this.trySplitBlock(
            block,
            constraints,
            contentWidth,
            pageHeight,
            usedHeight,
            previousBlock,
          );

          if (splitResult) {
            currentPage.push(splitResult.fittingBlock);
            usedHeight += this.getHeightIncrement(
              splitResult.fittingBlock,
              previousBlock,
            );
            currentPage = [];
            pages.push(currentPage);
            usedHeight = 0;
            queue.unshift(splitResult.remainderBlock);
            continue;
          }

          if (currentPage.length > 0) {
            currentPage = [];
            pages.push(currentPage);
            usedHeight = 0;
            queue.unshift(block);
            continue;
          }
        }

        currentPage.push(block);
        usedHeight += this.getHeightIncrement(
          block,
          currentPage[currentPage.length - 2],
        );
        continue;
      }

      const fragmentState = this.buildFragmentState(block, contentWidth);
      while (fragmentState.nextLineIndex < fragmentState.layoutLines.length) {
        const fragment = this.takeNextFragment(
          fragmentState,
          pageHeight,
          usedHeight,
          currentPage[currentPage.length - 1],
          currentPage.length === 0,
        );

        if (!fragment) {
          currentPage = [];
          pages.push(currentPage);
          usedHeight = 0;
          continue;
        }

        currentPage.push(fragment);
        usedHeight += fragment.heightIncrement;

        if (fragmentState.nextLineIndex < fragmentState.layoutLines.length) {
          currentPage = [];
          pages.push(currentPage);
          usedHeight = 0;
        }
      }
    }

    return pages.map((pageBlocks) => ({
      blocks: pageBlocks,
      html: this.renderPageBlocks(pageBlocks),
    }));
  }

  private trySplitBlock(
    block: DocumentBlock,
    constraints: PaginationConstraints,
    contentWidth: number,
    pageHeight: number,
    usedHeight: number,
    previousBlock: DocumentBlock | undefined,
  ): BlockSplitResult | null {
    if (
      !constraints.measurementRoot ||
      block.kind === 'image-block' ||
      block.kind === 'barcode-block'
    ) {
      return null;
    }

    const leadingSpacing = this.getLeadingSpacing(block, previousBlock);
    const availableHeight = Math.max(0, pageHeight - usedHeight - leadingSpacing);
    if (availableHeight <= 0) {
      return null;
    }

    const splitResult = this.splitHtmlToFit(
      block.html,
      availableHeight,
      contentWidth,
      constraints.measurementRoot,
    );

    if (!splitResult) {
      return null;
    }

    const fittingBlock: DocumentBlock = {
      ...block,
      chromeHeight: splitResult.fittingHeight,
      html: this.applyFragmentMargins(splitResult.fittingHtml, block.marginTop > 0, false),
      id: this.nextFragmentId(block.id),
      marginBottom: 0,
      measuredHeight: splitResult.fittingHeight,
    };

    const remainderBlock: DocumentBlock = {
      ...block,
      chromeHeight: splitResult.remainderHeight,
      html: this.applyFragmentMargins(splitResult.remainderHtml, false, block.marginBottom > 0),
      id: this.nextFragmentId(block.id),
      marginTop: 0,
      measuredHeight: splitResult.remainderHeight,
    };

    return {
      fittingBlock,
      remainderBlock,
    };
  }

  private splitHtmlToFit(
    html: string,
    availableHeight: number,
    contentWidth: number,
    measurementRoot: HTMLElement,
  ): {
    fittingHeight: number;
    fittingHtml: string;
    remainderHeight: number;
    remainderHtml: string;
  } | null {
    const normalizedRoot = this.parseHtmlRoot(html);
    if (!normalizedRoot) {
      return null;
    }

    const tableSplit = this.splitTableToFit(
      normalizedRoot,
      availableHeight,
      contentWidth,
      measurementRoot,
    );
    if (tableSplit) {
      return tableSplit;
    }

    const sourceWrapper = document.createElement('div');
    sourceWrapper.appendChild(this.cloneForMeasurement(normalizedRoot));

    const container = this.createMeasurementContainer(contentWidth);
    const targetWrapper = document.createElement('div');
    container.appendChild(targetWrapper);
    measurementRoot.appendChild(container);

    try {
      let source: Node = sourceWrapper;
      let target: Node = targetWrapper;

      while (source.firstChild) {
        const sourceNode = source.firstChild;
        target.appendChild(sourceNode);

        if (this.getMeasuredHeight(container) <= availableHeight) {
          if (
            sourceNode instanceof HTMLElement &&
            source instanceof HTMLElement &&
            source.tagName === 'OL'
          ) {
            const start = Number(source.getAttribute('start') ?? '1');
            source.setAttribute('start', `${start + 1}`);
          }
          continue;
        }

        const targetNode = sourceNode.cloneNode(false);
        targetNode.textContent = '';
        source.insertBefore(sourceNode, source.firstChild);
        target.appendChild(targetNode);

        if (this.getMeasuredHeight(container) > availableHeight) {
          target.removeChild(targetNode);

          const fittingHtml = targetWrapper.innerHTML.trim();
          const remainderHtml = sourceWrapper.innerHTML.trim();
          if (!fittingHtml || !remainderHtml) {
            return null;
          }

          return {
            fittingHeight: this.measureHtmlBoxHeight(
              fittingHtml,
              contentWidth,
              measurementRoot,
            ),
            fittingHtml,
            remainderHeight: this.measureHtmlBoxHeight(
              remainderHtml,
              contentWidth,
              measurementRoot,
            ),
            remainderHtml,
          };
        }

        if (sourceNode.nodeType === Node.TEXT_NODE) {
          const splitText = this.splitTextNodeToFit(
            sourceNode,
            targetNode,
            container,
            availableHeight,
          );

          if (!splitText) {
            target.removeChild(targetNode);
            return null;
          }

          const fittingHtml = targetWrapper.innerHTML.trim();
          const remainderHtml = sourceWrapper.innerHTML.trim();
          if (!fittingHtml || !remainderHtml) {
            return null;
          }

          return {
            fittingHeight: this.measureHtmlBoxHeight(
              fittingHtml,
              contentWidth,
              measurementRoot,
            ),
            fittingHtml,
            remainderHeight: this.measureHtmlBoxHeight(
              remainderHtml,
              contentWidth,
              measurementRoot,
            ),
            remainderHtml,
          };
        }

        source = sourceNode;
        target = targetNode;
      }

      return null;
    } finally {
      container.remove();
    }
  }

  private splitTableToFit(
    root: HTMLElement,
    availableHeight: number,
    contentWidth: number,
    measurementRoot: HTMLElement,
  ): {
    fittingHeight: number;
    fittingHtml: string;
    remainderHeight: number;
    remainderHtml: string;
  } | null {
    if (root.tagName !== 'TABLE') {
      return null;
    }

    const bodySections = Array.from(root.children).filter(
      (child): child is HTMLTableSectionElement =>
        child instanceof HTMLTableSectionElement &&
        child.tagName === 'TBODY',
    );
    if (bodySections.length === 0) {
      return null;
    }

    const fittingTable = root.cloneNode(false) as HTMLTableElement;
    this.setRootMargins(fittingTable, false, false);

    const fitSectionMap = new Map<HTMLTableSectionElement, HTMLTableSectionElement>();
    Array.from(root.children).forEach((child) => {
      if (!(child instanceof HTMLElement)) {
        return;
      }

      if (child.tagName === 'TBODY') {
        const sectionClone = child.cloneNode(false) as HTMLTableSectionElement;
        fittingTable.appendChild(sectionClone);
        fitSectionMap.set(child as HTMLTableSectionElement, sectionClone);
        return;
      }

      if (child.tagName !== 'TFOOT') {
        fittingTable.appendChild(child.cloneNode(true));
      }
    });

    const container = this.createMeasurementContainer(contentWidth);
    container.appendChild(fittingTable);
    measurementRoot.appendChild(container);

    let splitSectionIndex = -1;
    let splitRowIndex = -1;
    let fittedRowCount = 0;

    try {
      for (const [sectionIndex, section] of bodySections.entries()) {
        const fitSection = fitSectionMap.get(section);
        if (!fitSection) {
          continue;
        }

        const rows = Array.from(section.rows);
        for (const [rowIndex, row] of rows.entries()) {
          fitSection.appendChild(row.cloneNode(true));
          if (this.getMeasuredHeight(container) > availableHeight) {
            fitSection.removeChild(fitSection.lastChild as Node);
            splitSectionIndex = sectionIndex;
            splitRowIndex = rowIndex;
            break;
          }
          fittedRowCount += 1;
        }

        if (splitSectionIndex >= 0) {
          break;
        }
      }

      if (
        fittedRowCount === 0 ||
        splitSectionIndex < 0 ||
        splitRowIndex < 0
      ) {
        return null;
      }

      Array.from(fittingTable.querySelectorAll('tbody')).forEach((section) => {
        if (!section.rows.length) {
          section.remove();
        }
      });

      const remainderTable = root.cloneNode(false) as HTMLTableElement;
      this.setRootMargins(remainderTable, false, false);
      let bodySectionCursor = 0;
      Array.from(root.children).forEach((child) => {
        if (!(child instanceof HTMLElement)) {
          return;
        }

        if (child.tagName === 'TBODY') {
          const bodySection = child as HTMLTableSectionElement;
          const rows = Array.from(bodySection.rows);
          const sectionClone = bodySection.cloneNode(false) as HTMLTableSectionElement;
          const currentSectionIndex = bodySectionCursor;
          bodySectionCursor += 1;
          const rowStartIndex =
            currentSectionIndex === splitSectionIndex ? splitRowIndex : 0;
          if (currentSectionIndex < splitSectionIndex) {
            return;
          }

          rows.slice(rowStartIndex).forEach((row) => {
            sectionClone.appendChild(row.cloneNode(true));
          });
          if (sectionClone.rows.length > 0) {
            remainderTable.appendChild(sectionClone);
          }
          return;
        }

        if (child.tagName === 'TFOOT') {
          remainderTable.appendChild(child.cloneNode(true));
          return;
        }

        remainderTable.appendChild(child.cloneNode(true));
      });

      const fittingHtml = fittingTable.outerHTML;
      const remainderHtml = remainderTable.outerHTML;
      if (!remainderTable.tBodies.length || !remainderHtml.trim()) {
        return null;
      }

      return {
        fittingHeight: this.measureHtmlBoxHeight(
          fittingHtml,
          contentWidth,
          measurementRoot,
        ),
        fittingHtml,
        remainderHeight: this.measureHtmlBoxHeight(
          remainderHtml,
          contentWidth,
          measurementRoot,
        ),
        remainderHtml,
      };
    } finally {
      container.remove();
    }
  }

  private splitTextNodeToFit(
    sourceNode: Node,
    targetNode: Node,
    container: HTMLElement,
    availableHeight: number,
  ): boolean {
    const sourceText = sourceNode.textContent ?? '';
    if (!sourceText) {
      return false;
    }

    targetNode.textContent = sourceText[0];
    if (this.getMeasuredHeight(container) > availableHeight) {
      return false;
    }

    let offset = -1;
    let cursor = 0;

    while (cursor < sourceText.length) {
      const nextOffset = this.getUnbreakableSlice(sourceText, cursor + 1);
      const safeNextOffset =
        nextOffset <= cursor ? cursor + 1 : nextOffset;
      targetNode.textContent = sourceText.slice(0, safeNextOffset);
      if (this.getMeasuredHeight(container) > availableHeight) {
        break;
      }

      offset = safeNextOffset;
      cursor = safeNextOffset;
    }

    if (offset <= 0) {
      return false;
    }

    targetNode.textContent = sourceText.slice(0, offset);
    const isBreakingSpace = BREAKING_SPACE_CHARACTERS.includes(sourceText[offset] ?? '');
    sourceNode.textContent = sourceText.slice(isBreakingSpace ? offset + 1 : offset);
    return true;
  }

  private createMeasurementContainer(contentWidth: number): HTMLElement {
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.visibility = 'hidden';
    container.style.pointerEvents = 'none';
    container.style.left = '0';
    container.style.top = '0';
    container.style.width = `${contentWidth}px`;
    container.style.padding = '0';
    container.style.margin = '0';
    container.style.boxSizing = 'border-box';
    return container;
  }

  private measureHtmlBoxHeight(
    html: string,
    contentWidth: number,
    measurementRoot: HTMLElement,
  ): number {
    const root = this.parseHtmlRoot(html);
    if (!root) {
      return 0;
    }

    const container = this.createMeasurementContainer(contentWidth);
    container.appendChild(this.cloneForMeasurement(root));
    measurementRoot.appendChild(container);

    try {
      return this.getMeasuredHeight(container);
    } finally {
      container.remove();
    }
  }

  private parseHtmlRoot(html: string): HTMLElement | null {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();
    return wrapper.firstElementChild as HTMLElement | null;
  }

  private cloneForMeasurement(root: HTMLElement): HTMLElement {
    const clone = root.cloneNode(true) as HTMLElement;
    this.setRootMargins(clone, false, false);
    return clone;
  }

  private applyFragmentMargins(
    html: string,
    keepTopMargin: boolean,
    keepBottomMargin: boolean,
  ): string {
    const root = this.parseHtmlRoot(html);
    if (!root) {
      return html;
    }

    this.setRootMargins(root, keepTopMargin, keepBottomMargin);
    return root.outerHTML;
  }

  private setRootMargins(
    root: HTMLElement,
    keepTopMargin: boolean,
    keepBottomMargin: boolean,
  ): void {
    const style = root.getAttribute('style');
    const appended = [
      style?.trim(),
      keepTopMargin ? '' : 'margin-top: 0 !important',
      keepBottomMargin ? '' : 'margin-bottom: 0 !important',
    ]
      .filter(Boolean)
      .join('; ');

    if (appended) {
      root.setAttribute('style', appended);
      return;
    }

    root.removeAttribute('style');
  }

  private getMeasuredHeight(element: HTMLElement): number {
    return Math.ceil(element.getBoundingClientRect().height);
  }

  private getUnbreakableSlice(text: string, start = 0): number {
    let offset = start;

    for (const character of text.slice(start)) {
      if (
        BREAKING_SPACE_CHARACTERS.includes(character) ||
        '\t\n\r-–—\u00AD'.includes(character)
      ) {
        return offset;
      }
      offset += 1;
    }

    return offset;
  }

  private nextFragmentId(baseId: string): string {
    this.fragmentCounter += 1;
    return `${baseId}-fragment-${this.fragmentCounter}`;
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
    pageHeight: number,
    usedHeight: number,
    previousBlock: DocumentBlock | undefined,
    forceAtLeastOneLine: boolean,
  ): (DocumentBlock & { heightIncrement: number }) | null {
    const { block, lineRanges, layoutLines, nextLineIndex } = state;
    if (nextLineIndex >= layoutLines.length) {
      return null;
    }

    const isFirstFragment = nextLineIndex === 0;
    const marginTop = isFirstFragment ? block.marginTop : 0;
    const effectivePrevious = previousBlock
      ? { ...previousBlock, marginBottom: previousBlock.marginBottom }
      : undefined;
    const leadingSpacing = this.getLeadingSpacing(
      { ...block, marginTop, marginBottom: block.marginBottom },
      effectivePrevious,
    );
    const availableForLines =
      pageHeight - usedHeight - leadingSpacing - block.chromeHeight;
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
      const fragmentBoxHeight =
        block.chromeHeight +
        (endLineIndex - nextLineIndex) * block.lineHeight;
      const fragmentBottomMargin = isLastFragment ? block.marginBottom : 0;
      const heightIncrement =
        leadingSpacing + fragmentBoxHeight + fragmentBottomMargin;

      if (usedHeight + heightIncrement <= pageHeight || forceAtLeastOneLine) {
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
          heightIncrement,
          id: `${block.id}-fragment-${nextLineIndex}`,
          marginBottom: fragmentBottomMargin,
          marginTop,
          measuredHeight: fragmentBoxHeight,
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

  private getHeightIncrement(
    block: DocumentBlock,
    previousBlock?: DocumentBlock,
  ): number {
    return (
      this.getLeadingSpacing(block, previousBlock) +
      (block.measuredHeight ?? 0) +
      block.marginBottom
    );
  }

  private getLeadingSpacing(
    block: DocumentBlock,
    previousBlock?: DocumentBlock,
  ): number {
    if (!previousBlock) {
      return block.marginTop;
    }

    return Math.max(previousBlock.marginBottom, block.marginTop) - previousBlock.marginBottom;
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
