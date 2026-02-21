import { HtmlPageSplitter } from './HtmlPageSplitter';
import { splitHtmlToPages } from './splitHtmlToPages';
import {
  getUnbreakableSlice,
  isElement,
  makeAllParentListElementsTransparent,
} from './utilities';

describe('html-pages utilities', () => {
  it('calculates the next breakable slice respecting breaking characters', () => {
    expect(getUnbreakableSlice('hello world')).toBe(5);
    expect(getUnbreakableSlice('non­breaking')).toBe(3);
    expect(getUnbreakableSlice('already-breakable')).toBe(7);
    expect(getUnbreakableSlice('nowrap')).toBe(6);
  });

  it('detects element nodes correctly', () => {
    const element = document.createElement('div');
    const textNode = document.createTextNode('text');

    expect(isElement(element)).toBeTrue();
    expect(isElement(textNode)).toBeFalse();
  });

  it('marks parent list elements as transparent follow ups', () => {
    const list = document.createElement('ul');
    const item = document.createElement('li');
    const inner = document.createElement('span');

    item.appendChild(inner);
    list.appendChild(item);

    makeAllParentListElementsTransparent(inner);

    expect(item.classList.contains('html-pages__follow-up-list-item')).toBeTrue();
    expect(list.classList.contains('html-pages__follow-up-list-item')).toBeFalse();
  });
});

describe('splitHtmlToPages', () => {
  const createCountingContainer = (): HTMLElement => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientHeight', {
      get() {
        return this.childNodes.length;
      },
    });
    return container;
  };

  it('splits content into multiple pages based on page height', async () => {
    const container = createCountingContainer();
    const html = '<p>first</p><p>second</p>';
    const pages: string[] = [];

    for await (const page of splitHtmlToPages(html, {
      container,
      pageHeight: 1,
    })) {
      pages.push(page);
    }

    expect(pages.length).toBe(2);
    expect(pages[0]).toContain('first');
    expect(pages[1]).toContain('second');
  });

  it('respects the maximum number of pages option', async () => {
    const container = createCountingContainer();
    const html = '<div>one</div><div>two</div><div>three</div>';
    const pages: string[] = [];

    for await (const page of splitHtmlToPages(html, {
      container,
      pageHeight: 1,
      maxNumberOfPages: 1,
    })) {
      pages.push(page);
    }

    expect(pages.length).toBe(1);
    expect(pages[0]).toContain('one');
    expect(pages[0]).not.toContain('two');
  });

  it('uses default options when none are provided', async () => {
    const iterator = splitHtmlToPages('<p>single page</p>', undefined, {
      aborted: true,
    });
    const first = await iterator.next();

    expect(first.done).toBeTrue();
  });

  it('falls back when the source text content is missing', async () => {
    const heights = [2, 0, 0];
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientHeight', {
      get() {
        return heights.shift() ?? 0;
      },
    });
    const debugSourceContainer = document.createElement('div');
    const textNode = document.createTextNode('ignored');
    Object.defineProperty(textNode, 'textContent', {
      value: null,
      configurable: true,
    });
    debugSourceContainer.appendChild(textNode);

    const iterator = splitHtmlToPages('<p>ignored</p>', {
      container,
      debugSourceContainer,
      pageHeight: 0,
      debug: true,
    });

    const first = await iterator.next();
    expect(first.value).toBeDefined();
  });

  it('splits long text nodes across multiple pages', async () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientHeight', {
      get() {
        return Math.ceil((container.textContent?.length ?? 0) / 3);
      },
    });

    const pages: string[] = [];
    for await (const page of splitHtmlToPages('<p>abcdefghij</p>', {
      container,
      pageHeight: 1,
      maxNumberOfPages: 2,
    })) {
      pages.push(page);
    }

    expect(pages.length).toBe(2);
  });

  it('creates and removes a temporary container when none is supplied', async () => {
    const pages: string[] = [];

    for await (const page of splitHtmlToPages('<p>single</p>', {
      classes: ['temp-marker'],
      pageHeight: 2,
      maxNumberOfPages: 1,
    })) {
      pages.push(page);
    }

    expect(pages.length).toBeGreaterThan(0);
    expect(document.querySelector('.temp-marker')).toBeNull();
  });
});

describe('HtmlPageSplitter', () => {
  it('aborts ongoing splits when requested', async () => {
    const splitter = new HtmlPageSplitter({
      container: (() => {
        const container = document.createElement('div');
        Object.defineProperty(container, 'clientHeight', {
          get() {
            return this.childNodes.length;
          },
        });
        return container;
      })(),
      pageHeight: 1,
    });

    const pages: string[] = [];
    const iterator = splitter.split('<p>a</p><p>b</p>');

    const first = await iterator.next();
    pages.push(first.value as string);

    splitter.abort();

    const second = await iterator.next();

    expect(second.done).toBeTrue();
    expect(pages.length).toBe(1);
    expect(pages[0]).toContain('a');
  });

  it('supports default constructor options', async () => {
    const splitter = new HtmlPageSplitter();
    const iterator = splitter.split('<p>content</p>');
    const result = await iterator.next();

    expect(result.value).toBeDefined();
  });
});
