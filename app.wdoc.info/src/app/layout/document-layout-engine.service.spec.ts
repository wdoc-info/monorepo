import { TestBed } from '@angular/core/testing';
import { DocumentLayoutEngineService } from './document-layout-engine.service';
import { TextLayoutService } from './text-layout.service';
import { type DocumentBlock } from './layout.types';

describe('DocumentLayoutEngineService', () => {
  let service: DocumentLayoutEngineService;
  let textLayoutService: TextLayoutService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DocumentLayoutEngineService);
    textLayoutService = TestBed.inject(TextLayoutService);
  });

  const createTextBlock = (id: string, text: string): DocumentBlock => {
    const font = '16px Arial';
    const lineHeight = 20;
    const metrics = textLayoutService.measureText(text, font, lineHeight, 200, 'normal');

    return {
      atomic: false,
      chromeHeight: 0,
      font,
      html: `<p style="font-family: Arial; font-size: 16px; line-height: 20px; overflow-wrap: break-word; word-break: normal; white-space: normal;">${text}</p>`,
      id,
      kind: 'text-block',
      lineCount: metrics.lineCount,
      lineHeight,
      marginBottom: 0,
      marginTop: 0,
      measuredHeight: metrics.height,
      text,
      whiteSpace: 'normal',
    };
  };

  it('paginates long text across multiple pages', () => {
    const pages = service.paginateBlocks(
      [createTextBlock('long', 'hello world '.repeat(120))],
      {
        pageHeight: 120,
        pagePadding: 0,
        pageWidth: 200,
        reservedBottom: 0,
        reservedTop: 0,
      },
    );

    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].html).toContain('<p');
  });

  it('moves oversized atomic blocks to a new page', () => {
    const pages = service.paginateBlocks(
      [
        createTextBlock('intro', 'short text'),
        {
          atomic: true,
          chromeHeight: 70,
          font: '16px Arial',
          html: '<div class="card">Heavy block</div>',
          id: 'card',
          kind: 'raw-html-block',
          lineHeight: 20,
          marginBottom: 0,
          marginTop: 0,
          measuredHeight: 70,
          whiteSpace: 'normal',
        },
      ],
      {
        pageHeight: 60,
        pagePadding: 0,
        pageWidth: 200,
        reservedBottom: 0,
        reservedTop: 0,
      },
    );

    expect(pages.length).toBe(2);
    expect(pages[1].html).toContain('Heavy block');
  });

  it('groups list items back into a single list container', () => {
    const pages = service.paginateBlocks(
      [
        {
          ...createTextBlock('item-1', 'First item'),
          html: '<li>First item</li>',
          kind: 'list-block',
          listMeta: {
            attrs: { class: 'ordered' },
            itemIndex: 3,
            tagName: 'ol',
          },
        },
        {
          ...createTextBlock('item-2', 'Second item'),
          html: '<li>Second item</li>',
          kind: 'list-block',
          listMeta: {
            attrs: { class: 'ordered' },
            itemIndex: 4,
            tagName: 'ol',
          },
        },
      ],
      {
        pageHeight: 200,
        pagePadding: 0,
        pageWidth: 200,
        reservedBottom: 0,
        reservedTop: 0,
      },
    );

    expect(pages.length).toBe(1);
    expect(pages[0].html).toContain('<ol');
    expect(pages[0].html).toContain('start="3"');
    expect(pages[0].html).toContain('First item');
    expect(pages[0].html).toContain('Second item');
  });
});
