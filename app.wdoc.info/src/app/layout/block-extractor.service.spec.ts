import { TestBed } from '@angular/core/testing';
import {
  DEFAULT_DOCUMENT_FONT,
  DEFAULT_DOCUMENT_LINE_HEIGHT_PX,
  DEFAULT_PAGE_PADDING,
  DEFAULT_PAGE_WIDTH,
} from './layout.constants';
import { BlockExtractorService } from './block-extractor.service';

describe('BlockExtractorService', () => {
  let service: BlockExtractorService;
  let measurementRoot: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(BlockExtractorService);
    measurementRoot = document.createElement('div');
    document.body.appendChild(measurementRoot);
  });

  afterEach(() => {
    measurementRoot.remove();
  });

  it('extracts text blocks for compatible paragraphs', () => {
    const blocks = service.extractBlocksFromHtml(
      '<p style="font-family: Arial; font-size: 16px; line-height: 20px; overflow-wrap: break-word; word-break: normal; white-space: normal;">Hello world</p>',
      {
        contentWidth: DEFAULT_PAGE_WIDTH - DEFAULT_PAGE_PADDING * 2,
        defaultFont: DEFAULT_DOCUMENT_FONT,
        defaultLineHeight: DEFAULT_DOCUMENT_LINE_HEIGHT_PX,
        measurementRoot,
      },
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('text-block');
    expect(blocks[0].atomic).toBeFalse();
    expect(blocks[0].text).toContain('Hello world');
  });

  it('falls back to raw html blocks when the font policy is unsupported', () => {
    const blocks = service.extractBlocksFromHtml(
      '<div style="font-family: system-ui; font-size: 16px; line-height: 20px; overflow-wrap: break-word; word-break: normal; white-space: normal;">Hello world</div>',
      {
        contentWidth: DEFAULT_PAGE_WIDTH - DEFAULT_PAGE_PADDING * 2,
        defaultFont: DEFAULT_DOCUMENT_FONT,
        defaultLineHeight: DEFAULT_DOCUMENT_LINE_HEIGHT_PX,
        measurementRoot,
      },
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('raw-html-block');
    expect(blocks[0].atomic).toBeTrue();
  });
});
