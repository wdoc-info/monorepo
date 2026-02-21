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

  it('exposes basic formatting commands', async () => {
    component.toggleBold();
    component.toggleItalic();
    component.toggleBulletList();
    component.toggleOrderedList();
    component.setHeading(2);

    await settle();
    expect(component.editor?.isActive('heading', { level: 2 })).toBeTrue();
  });

  it('clears the placeholder when the editor gains focus', async () => {
    const editor = component.editor!;
    editor.options.onFocus?.({ editor } as any);

    await settle();
    expect(editor.getHTML()).toBe('<p></p>');
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
