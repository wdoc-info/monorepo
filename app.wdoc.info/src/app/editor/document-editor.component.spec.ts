import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SimpleChange } from '@angular/core';
import { DocumentEditorComponent } from './document-editor.component';

describe('DocumentEditorComponent', () => {
  let fixture: ComponentFixture<DocumentEditorComponent>;
  let component: DocumentEditorComponent;
  const flushRaf = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const settle = async () => {
    await fixture.whenStable();
    await flushRaf();
    fixture.detectChanges();
    await flushRaf();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DocumentEditorComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DocumentEditorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await settle();
  });

  it('emits content changes when the document updates', async () => {
    const emitSpy = spyOn(component.contentChange, 'emit');
    spyOn(component.assetsChange, 'emit');
    component.editor?.commands.setContent('<p>Updated</p>');
    await flushRaf();
    expect(emitSpy).toHaveBeenCalled();
  });

  it('updates the live document when the input content changes', async () => {
    component.content = '<p>Reset</p>';
    component.ngOnChanges({
      content: new SimpleChange(undefined, component.content, false),
    });

    await settle();

    expect(component.editor?.getHTML()).toContain('Reset');
  });

  it('preserves tables when loading HTML into the editor', async () => {
    component.content =
      '<table><tbody><tr><th>Test</th></tr><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table>';
    component.ngOnChanges({
      content: new SimpleChange(undefined, component.content, false),
    });

    await settle();

    const html = component.editor?.getHTML() ?? '';
    expect(html).toContain('<table');
    expect(html).toContain('<tbody');
    expect(html).toContain('<th>Test</th>');
    expect(component.pageContents.join('')).toContain('<table');
  });
  it('retains generated embedded-resource links while rejecting active script URLs', async () => {
    const editor = component.editor!;
    editor.commands.setContent('<p><a href="blob:embedded-guide">Guide</a> <a href="javascript:alert(1)">Unsafe link</a></p>');
    await settle();
    expect(editor.getHTML()).toContain('href="blob:embedded-guide"');
    expect(editor.getHTML()).not.toContain('javascript:');
    expect(editor.getHTML()).toContain('Unsafe link');
  });

  it('exposes basic formatting commands', async () => {
    component.toggleBold();
    component.toggleItalic();
    component.toggleBulletList();
    component.toggleOrderedList();
    component.setHeading(2);

    await settle();
    expect(component.editor?.isActive('heading', { level: 2 })).toBeTrue();
  });

  it('filters Google Fonts by name without downloading fonts', () => {
    const add = spyOn(component.fonts, 'add');
    component.fontSearch.set('jEtBrAiNs');
    fixture.detectChanges();
    const options = fixture.nativeElement.querySelectorAll('optgroup[label="Google Fonts"] option');
    expect(Array.from(options, (option: any) => option.textContent.trim())).toEqual(['JetBrains Mono']);
    expect(add).not.toHaveBeenCalled();
  });

  it('loads a Google font before applying it to the original text selection', async () => {
    const editor = component.editor!;
    editor.commands.setContent('<p>First second</p>');
    await settle();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    let finish!: () => void;
    const loaded = new Promise<void>(resolve => finish = resolve);
    const add = spyOn(component.fonts, 'add').and.callFake(async () => {
      await loaded;
      component.fonts.families.set([{ name: 'Inter', alias: 'wdoc-test-inter' }]);
    });

    const selecting = component.selectFont('google:Inter');
    fixture.detectChanges();
    await Promise.resolve();
    expect(component.addingFont).toBeTrue();
    expect(fixture.nativeElement.querySelector('[aria-label="Document font"]').disabled).toBeTrue();
    expect(editor.getHTML()).not.toContain('wdoc-test-inter');
    finish();
    await selecting;
    await settle();

    expect(add).toHaveBeenCalledWith('Inter', jasmine.stringMatching(/^https:\/\/fonts.googleapis.com\/css2\?/));
    expect(editor.getHTML()).toContain('<span style="font-family: wdoc-test-inter;">First</span> second');
    expect(component.selectedFont).toBe('wdoc-test-inter');
    await component.selectFont('google:Inter');
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing font and exposes a loading error next to the toolbar', async () => {
    component.fonts.families.set([{ name: 'Existing font', alias: 'wdoc-existing' }]);
    component.editor!.commands.setContent('<p><span style="font-family:wdoc-existing">Keep this font</span></p>');
    await settle();
    component.editor!.commands.setTextSelection({ from: 1, to: 5 });
    component.selectedFont = 'wdoc-existing';
    spyOn(component.fonts, 'add').and.rejectWith(new Error('The font could not be loaded.'));

    await component.selectFont('google:Lora');
    fixture.detectChanges();

    expect(component.selectedFont).toBe('wdoc-existing');
    expect(component.addingFont).toBeFalse();
    expect(component.editor!.getHTML()).toContain('wdoc-existing');
    expect(fixture.nativeElement.querySelector('.font-error[role="alert"]').textContent).toContain('could not be loaded');
  });

  it('keeps the selected font for subsequent typing and a new paragraph', async () => {
    component.fonts.families.set([{ name: 'Inter', alias: 'wdoc-typing' }]);
    const editor = component.editor!;
    editor.options.onFocus?.({ editor } as any);
    await settle();
    await component.selectFont('google:Inter');
    editor.commands.insertContent('First line');
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    editor.commands.insertContent('Second line');
    await settle();
    expect(editor.getHTML()).toContain('<span style="font-family: wdoc-typing;">First line</span>');
    expect(editor.getHTML()).toContain('<span style="font-family: wdoc-typing;">Second line</span>');
  });

  it('does not apply an old selection to text edited during font loading', async () => {
    const editor = component.editor!;
    editor.commands.setContent('<p>Original text</p>');
    await settle();
    let finish!: () => void;
    spyOn(component.fonts, 'add').and.returnValue(new Promise<void>(resolve => finish = resolve));
    const selecting = component.selectFont('google:Inter');
    editor.commands.setContent('<p>Changed text</p>');
    finish();
    await selecting;
    expect(editor.getHTML()).toBe('<p>Changed text</p>');
    expect(component.fontError).toContain('text changed');
    expect(component.addingFont).toBeFalse();
  });

  it('applies fonts to the active page instead of the first page', async () => {
    component.pageHeight = 120;
    component.content = '<p>Page text with several words.</p>'.repeat(8);
    component.ngOnChanges({ content: new SimpleChange(undefined, component.content, false) });
    await settle();
    const firstEditor = component.editor!;
    const pages = fixture.nativeElement.querySelectorAll('[contenteditable="true"]');
    expect(pages.length).toBeGreaterThan(1);
    pages[1].focus();
    await settle();
    const activeEditor = component.editor!;
    expect(activeEditor).not.toBe(firstEditor);
    activeEditor.commands.selectAll();
    component.applyFont('wdoc-second-page');
    expect(activeEditor.getHTML()).toContain('wdoc-second-page');
    expect(firstEditor.getHTML()).not.toContain('wdoc-second-page');
  });

  it('clears the placeholder when the editor gains focus', async () => {
    const editor = component.editor!;
    editor.options.onFocus?.({ editor } as any);

    await settle();
    expect(editor.getHTML()).toBe('<p></p>');
  });

  it('keeps an empty paragraph when pressing Enter in a new document', async () => {
    const editor = component.editor!;
    editor.options.onFocus?.({ editor } as any);
    await settle();

    editor.commands.insertContent('Hello');
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    const html = component.pageContents.join('');
    expect(html).toContain('<p>Hello</p>');
    expect(html).toContain('<p></p>');
  });

  it('paginates content when the available height is exceeded', async () => {
    component.pageHeight = 120;
    component.content = `<p>${'line<br>'.repeat(200)}</p>`;
    component.ngOnChanges({
      content: new SimpleChange(undefined, component.content, false),
    });

    await settle();
    expect(component.pageContents.length).toBeGreaterThan(1);
  });

  it('applies color commands to the current selection', async () => {
    component.applyTextColor('#123456');
    component.applyHighlight('#abcdef');

    await settle();

    expect(component.textColor).toBe('#123456');
    expect(component.highlightColor).toBe('#abcdef');
  });

  it('persists text color and highlight when starting a new paragraph', async () => {
    const editor = component.editor!;
    editor.commands.setContent('<p>Colorful</p>');
    editor.commands.selectAll();

    component.applyTextColor('#112233');
    component.applyHighlight('#aabbcc');

    editor.commands.setTextSelection(editor.state.doc.content.size);
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    editor.commands.insertContent('Carry styles');

    await settle();

    const html = editor.getHTML();
    expect(html).toContain('rgb(17, 34, 51)');
    expect(html).toContain('#aabbcc');
  });

  it('opens the image picker when requested', () => {
    const click = jasmine.createSpy('click');
    component.imageInput = { nativeElement: { click } } as any;

    component.openImagePicker();

    expect(click).toHaveBeenCalled();
  });

  it('inserts an image when a file is chosen', async () => {
    const editor = component.editor!;
    const chain = jasmine.createSpyObj('chain', ['focus', 'setImage', 'run']);
    chain.focus.and.returnValue(chain);
    chain.setImage.and.returnValue(chain);
    chain.run.and.returnValue(undefined);
    spyOn(editor, 'chain').and.returnValue(chain as any);
    const assetsSpy = spyOn(component.assetsChange, 'emit');
    spyOn(URL, 'createObjectURL').and.returnValue('blob:url');

    const file = new File(['image-bytes'], 'photo.png', { type: 'image/png' });
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [file] });
    input.value = 'mock-path';
    component.imageInput = { nativeElement: input } as any;

    const OriginalReader = FileReader;
    class MockReader {
      result: string | ArrayBuffer | null = null;
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => any) | null = null;
      readAsDataURL() {
        this.result = 'data:image/png;base64,stub';
        this.onload?.call(this as any, {} as ProgressEvent<FileReader>);
      }
    }

    (window as any).FileReader = MockReader as any;

    const OriginalImage = (window as any).Image;

    class MockImage {
      naturalWidth = 2000;
      naturalHeight = 1500;
      onload: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    }

    (window as any).Image = MockImage as any;

    component.onImageSelected({ target: input } as unknown as Event);

    await settle();

    expect(chain.setImage).toHaveBeenCalledWith({
      src: 'blob:url',
      alt: 'photo.png',
      width: jasmine.any(Number),
      height: jasmine.any(Number),
      'data-asset-src': 'wdoc-assets/photo.png',
    });
    expect(input.value).toBe('');
    expect(assetsSpy).toHaveBeenCalled();

    (window as any).Image = OriginalImage as any;
    (window as any).FileReader = OriginalReader as any;
  });

  it('resizes a selected image within page bounds', async () => {
    const editor = component.editor!;
    editor.commands.setContent('<img src="data:image/png;base64,abc" alt="image" />');
    await settle();

    const renderedImage = editor.view.dom.querySelector('img') as HTMLImageElement;
    Object.defineProperty(renderedImage, 'naturalWidth', { value: 1200 });
    Object.defineProperty(renderedImage, 'naturalHeight', { value: 900 });

    const chain = jasmine.createSpyObj('chain', [
      'focus',
      'updateAttributes',
      'run',
      'setNodeSelection',
    ]);
    chain.focus.and.returnValue(chain);
    chain.updateAttributes.and.returnValue(chain);
    chain.setNodeSelection.and.returnValue(chain);
    spyOn(editor, 'chain').and.returnValue(chain as any);

    component.handleEditorClick({ target: renderedImage } as any);
    component.onImageSizeChange('50');

    expect(component.selectedImageSize).toBe(50);
    expect(chain.setNodeSelection).toHaveBeenCalled();
    expect(chain.updateAttributes).toHaveBeenCalledWith('image', {
      width: jasmine.any(Number),
      height: jasmine.any(Number),
    });
    expect(renderedImage.width).toBeGreaterThan(0);
  });
});
