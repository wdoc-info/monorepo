import {
  AfterViewInit,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  OnChanges,
  SimpleChanges,
  Output,
  QueryList,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Level } from '@tiptap/extension-heading';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TipTapImage from '@tiptap/extension-image';
import { TextStyle } from '@tiptap/extension-text-style';

export interface EditorAsset {
  objectUrl: string;
  path: string;
  file: File;
}

@Component({
  selector: 'app-document-editor',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './document-editor.component.html',
  styleUrls: ['./document-editor.component.css'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class DocumentEditorComponent
  implements OnInit, AfterViewInit, OnDestroy, OnChanges
{
  @Input() content = '<p>Start writing...</p>';
  @Output() contentChange = new EventEmitter<string>();
  @Output() assetsChange = new EventEmitter<EditorAsset[]>();
  @ViewChildren('pageHost') pageHosts?: QueryList<ElementRef<HTMLElement>>;
  @ViewChild('imageInput') imageInput?: ElementRef<HTMLInputElement>;

  private editors: Editor[] = [];
  private pendingExternalUpdate = false;
  pageHeight = 1122;
  pageWidth = 793.8;
  pagePadding = 20;
  private pageGap = 20;
  pageContents: string[] = [];
  private resizeObservers: ResizeObserver[] = [];
  private paginationRaf = 0;
  private placeholderCleared = false;
  private pendingSelectionOffset: number | null = null;
  private selectedImageEditor?: Editor;
  private selectedImagePos: number | null = null;
  private imageAssets = new Map<string, EditorAsset>();
  textColor = '#000000';
  highlightColor = '#fff59d';
  selectedImage: HTMLImageElement | null = null;
  selectedImageSize = 100;
  readonly headingLevels: Level[] = [1, 2, 3, 4, 5, 6];

  get editor(): Editor | undefined {
    return this.editors[0];
  }

  ngOnInit(): void {
    this.placeholderCleared = this.content !== '<p>Start writing...</p>';
    this.updatePagesFromHtml(this.content);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (
      changes['content'] &&
      this.editors.length &&
      typeof changes['content'].currentValue === 'string'
    ) {
      const currentHtml = this.editors
        .map((editor) => editor.getHTML())
        .join('');
      if (currentHtml !== this.content) {
        this.pendingExternalUpdate = true;
        this.updatePagesFromHtml(this.content);
        queueMicrotask(() => (this.pendingExternalUpdate = false));
      }
    }

    if (changes['content']) {
      this.placeholderCleared = this.content !== '<p>Start writing...</p>';
    }
  }

  ngAfterViewInit(): void {
    this.syncEditorsToHosts();
    this.pageHosts?.changes.subscribe(() => this.syncEditorsToHosts());
  }

  ngOnDestroy(): void {
    this.imageAssets.forEach((asset) => URL.revokeObjectURL(asset.objectUrl));
    this.editors.forEach((editor) => editor.destroy());
    this.editors = [];
    this.resizeObservers.forEach((observer) => observer.disconnect());
    this.resizeObservers = [];
    if (this.paginationRaf) {
      cancelAnimationFrame(this.paginationRaf);
      this.paginationRaf = 0;
    }
  }

  toggleBold() {
    this.editors[0]?.chain().focus().toggleBold().run();
  }

  toggleItalic() {
    this.editors[0]?.chain().focus().toggleItalic().run();
  }

  toggleBulletList() {
    this.editors[0]?.chain().focus().toggleBulletList().run();
  }

  toggleOrderedList() {
    this.editors[0]?.chain().focus().toggleOrderedList().run();
  }

  setHeading(level: Level) {
    this.editors[0]?.chain().focus().toggleHeading({ level }).run();
  }

  applyTextColor(color: string) {
    this.textColor = color;
    this.editors[0]?.chain().focus().setColor(color).run();
  }

  applyHighlight(color: string) {
    this.highlightColor = color;
    this.editors[0]?.chain().focus().setHighlight({ color }).run();
  }

  clearHighlight() {
    this.editors[0]?.chain().focus().unsetHighlight().run();
  }

  openImagePicker() {
    this.imageInput?.nativeElement.click();
  }

  onImageSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const objectUrl = URL.createObjectURL(file);
      const assetPath = this.registerAsset(file, objectUrl);

      const previewImage = new window.Image();
      previewImage.onload = () => {
        const { width, height } = this.constrainImageDimensions(
          previewImage.naturalWidth,
          previewImage.naturalHeight,
        );

        const imageAttributes: Record<string, unknown> = {
          src: objectUrl,
          alt: file.name,
          width,
          height,
          'data-asset-src': assetPath,
        };

        this.editors[0]
          ?.chain()
          .focus()
          .setImage(imageAttributes as any)
          .run();
      };

      previewImage.src = objectUrl;

      if (this.imageInput?.nativeElement) {
        this.imageInput.nativeElement.value = '';
      }
    };

    reader.readAsDataURL(file);
  }

  private registerAsset(file: File, objectUrl: string): string {
    const assetPath = this.buildAssetPath(file.name);
    this.imageAssets.set(objectUrl, { objectUrl, path: assetPath, file });
    this.assetsChange.emit(Array.from(this.imageAssets.values()));
    return assetPath;
  }

  private buildAssetPath(name: string): string {
    const trimmed = name.trim() || 'image';
    const lastDot = trimmed.lastIndexOf('.');
    const base = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed;
    const extension = lastDot > 0 ? trimmed.slice(lastDot) : '';
    let candidate = `wdoc-assets/${trimmed}`;
    let counter = 1;

    const existingPaths = new Set(
      Array.from(this.imageAssets.values()).map((asset) => asset.path),
    );

    while (existingPaths.has(candidate)) {
      candidate = `wdoc-assets/${base}-${counter}${extension}`;
      counter += 1;
    }

    return candidate;
  }

  handleEditorClick(event: Event) {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLImageElement) {
      this.selectedImage = target;
      this.selectedImageEditor = this.editors.find((editor) =>
        editor.view.dom.contains(target),
      );
      this.selectedImagePos = this.selectedImageEditor?.view.posAtDOM(
        target,
        0,
      ) ?? null;
      this.selectedImageSize = this.estimateImagePercentage(target);
      return;
    }

    this.clearImageSelection();
  }

  onImageSizeChange(value: number | string) {
    if (!this.selectedImage || !this.selectedImageEditor) {
      return;
    }

    const parsed = Math.max(10, Math.min(100, Number(value)));
    this.selectedImageSize = parsed;

    const { width, height } = this.constrainImageDimensions(
      this.selectedImage.naturalWidth,
      this.selectedImage.naturalHeight,
      parsed,
    );

    const attributes: { width: number; height?: number } = { width };
    if (height !== undefined) {
      attributes['height'] = height;
    }

    this.selectedImage.width = width;
    if (height !== undefined) {
      this.selectedImage.height = height;
    } else {
      this.selectedImage.removeAttribute('height');
    }

    const selectionPos =
      this.selectedImagePos ??
      this.selectedImageEditor.view.posAtDOM(this.selectedImage, 0);

    let chain = this.selectedImageEditor.chain().focus();
    if (typeof selectionPos === 'number') {
      chain = chain.setNodeSelection(selectionPos);
    }

    chain.updateAttributes('image', attributes).run();
  }

  clearImageSelection() {
    this.selectedImage = null;
    this.selectedImageEditor = undefined;
    this.selectedImagePos = null;
  }

  private getMaxImageWidth(): number {
    return Math.max(0, this.pageWidth - this.pagePadding * 2);
  }

  private getMaxImageHeight(): number {
    return Math.max(0, this.pageHeight - this.pagePadding * 2);
  }

  private constrainImageDimensions(
    width: number,
    height: number,
    percentage = 100,
  ): { width: number; height?: number } {
    const maxWidth = (this.getMaxImageWidth() * Math.max(percentage, 10)) / 100;
    const maxHeight = (this.getMaxImageHeight() * Math.max(percentage, 10)) / 100;

    if (!width || !height) {
      return {
        width: Math.floor(maxWidth),
        height: Math.floor(maxHeight),
      };
    }

    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const constrainedWidth = Math.floor(width * scale);
    const constrainedHeight = Math.floor(height * scale);

    return {
      width: constrainedWidth,
      height: constrainedHeight,
    };
  }

  private estimateImagePercentage(image: HTMLImageElement): number {
    const maxWidth = this.getMaxImageWidth();
    const rawWidth = image.getAttribute('width')
      ? Number(image.getAttribute('width'))
      : image.clientWidth || maxWidth;

    if (!rawWidth || !maxWidth) {
      return 100;
    }

    const percentage = Math.round((rawWidth / maxWidth) * 100);
    return Math.min(100, Math.max(10, percentage));
  }

  isActive(name: string, attrs?: Record<string, unknown>) {
    return this.editors[0]?.isActive(name, attrs) ?? false;
  }

  private schedulePaginationUpdate(): void {
    if (this.paginationRaf) {
      cancelAnimationFrame(this.paginationRaf);
    }
    this.paginationRaf = requestAnimationFrame(() => {
      this.paginationRaf = 0;
      this.updatePagination();
    });
  }

  private updatePagination(): void {
    if (!this.editors.length) {
      return;
    }

    const mergedHtml = this.editors.map((editor) => editor.getHTML()).join('');
    this.updatePagesFromHtml(mergedHtml);
  }

  private updatePagesFromHtml(html: string): void {
    this.pageContents = this.paginateHtml(html);
    requestAnimationFrame(() => this.syncEditorsToHosts());
  }

  private paginateHtml(html: string): string[] {
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.visibility = 'hidden';
    container.style.pointerEvents = 'none';
    container.style.width = `${this.pageWidth - this.pagePadding * 2}px`;
    container.style.padding = '0';
    container.style.boxSizing = 'border-box';
    container.style.lineHeight = '1.6';
    container.style.fontSize = '16px';
    container.style.fontFamily = 'inherit';
    container.innerHTML = html || '<p></p>';

    document.body.appendChild(container);

    const pages: string[] = [];
    const usableHeight = this.pageHeight - this.pagePadding * 2;
    let currentPage = document.createElement('div');
    currentPage.style.width = '100%';
    pages.push('');

    const moveToNewPage = (node: Node) => {
      const newPage = document.createElement('div');
      newPage.appendChild(node.cloneNode(true));
      pages.push(newPage.innerHTML);
      currentPage = newPage;
    };

    Array.from(container.childNodes).forEach((node) => {
      currentPage.appendChild(node.cloneNode(true));
      container.innerHTML = currentPage.innerHTML;

      if (container.scrollHeight > usableHeight) {
        currentPage.removeChild(currentPage.lastChild as ChildNode);
        pages[pages.length - 1] = currentPage.innerHTML;
        moveToNewPage(node);
        container.innerHTML = currentPage.innerHTML;
      } else {
        pages[pages.length - 1] = currentPage.innerHTML;
      }
    });

    document.body.removeChild(container);

    return pages.length ? pages : ['<p></p>'];
  }

  private syncEditorsToHosts(): void {
    if (!this.pageHosts) {
      return;
    }

    const hosts = this.pageHosts.toArray();

    // Ensure editor instances match page count
    while (this.editors.length < this.pageContents.length && hosts[this.editors.length]) {
      const index = this.editors.length;
      const host = hosts[index].nativeElement;
      const editor = this.createEditor(host, this.pageContents[index], index);
      this.editors.push(editor);
      this.observeEditorHeight(host);
    }

    // Remove extra editors if pagination shrank
    while (this.editors.length > this.pageContents.length) {
      const editor = this.editors.pop();
      editor?.destroy();
      const observer = this.resizeObservers.pop();
      observer?.disconnect();
    }

    // Update host elements if they changed
    this.editors.forEach((editor, index) => {
      const host = hosts[index]?.nativeElement;
      if (host && editor.options.element !== host) {
        editor.setOptions({ element: host });
        host.replaceChildren(...Array.from(editor.view.dom.childNodes));
      }
      if (editor.getHTML() !== this.pageContents[index]) {
        this.pendingExternalUpdate = true;
        editor.commands.setContent(this.pageContents[index], { emitUpdate: false });
        queueMicrotask(() => (this.pendingExternalUpdate = false));
      }
    });

    if (this.pendingSelectionOffset !== null) {
      this.applySelectionOffset(this.pendingSelectionOffset);
      this.pendingSelectionOffset = null;
    }
  }

  private createEditor(element: HTMLElement, content: string, index: number): Editor {
    let instance: Editor;

    const PageImage = TipTapImage.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          width: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('width'),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes['width'] ? { width: attributes['width'] } : {},
          },
          height: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('height'),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes['height'] ? { height: attributes['height'] } : {},
          },
          'data-asset-src': {
            default: null,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute('data-asset-src'),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes['data-asset-src']
                ? { 'data-asset-src': attributes['data-asset-src'] }
                : {},
          },
        };
      },
    });

    instance = new Editor({
      element,
      extensions: [
        StarterKit.configure({
          heading: {
            levels: this.headingLevels,
          },
        }),
        TextStyle,
        Color,
        Highlight.configure({ multicolor: true }),
        PageImage.configure({
          inline: true,
          allowBase64: true,
          HTMLAttributes: { class: 'editor-image' },
        }),
      ],
      content,
      editorProps: {
        handleKeyDown: (view, event) => {
          if (event.key === 'Enter') {
            const activeMarks =
              instance.state.storedMarks ?? instance.state.selection.$from.marks();
            const activeTextColor = activeMarks?.find(
              (mark) => mark.type.name === 'textStyle' && mark.attrs['color'],
            )?.attrs['color'] as string | undefined;
            const activeHighlight = activeMarks?.find(
              (mark) => mark.type.name === 'highlight' && mark.attrs['color'],
            )?.attrs['color'] as string | undefined;

            const splitApplied = instance.commands.splitBlock();

            if (splitApplied && (activeTextColor || activeHighlight)) {
              const chain = instance.chain().focus();

              if (activeTextColor) {
                chain.setColor(activeTextColor);
              }

              if (activeHighlight) {
                chain.setHighlight({ color: activeHighlight });
              }

              chain.run();
            }

            return splitApplied;
          }

          return false;
        },
      },
      onUpdate: ({ editor }) => {
        if (this.pendingExternalUpdate) {
          return;
        }

        this.pendingSelectionOffset = this.calculateSelectionOffset(index, editor);
        const mergedHtml = this.editors
          .map((inst, idx) => (idx === index ? editor.getHTML() : inst.getHTML()))
          .join('');

        this.contentChange.emit(mergedHtml);
        this.updatePagesFromHtml(mergedHtml);
      },
      onFocus: ({ editor }) => {
        if (this.placeholderCleared || index !== 0) {
          return;
        }

        const currentHtml = editor.getHTML().trim();
        if (currentHtml === '<p>Start writing...</p>') {
          this.placeholderCleared = true;
          editor.commands.setContent('<p></p>');
          this.schedulePaginationUpdate();
        }
      },
    });

    return instance;
  }

  private calculateSelectionOffset(index: number, editor: Editor): number {
    const selection = editor.state.selection;
    const offsetInsideEditor = Math.max(0, selection.from - 1);
    let offset = offsetInsideEditor;

    for (let i = 0; i < index; i++) {
      const size = this.getEditorContentSize(this.editors[i]);
      offset += size;
    }

    return offset;
  }

  private getEditorContentSize(editor: Editor | undefined): number {
    return editor?.state.doc.content.size ?? 0;
  }

  private observeEditorHeight(host: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => this.schedulePaginationUpdate());
    observer.observe(host);
    this.resizeObservers.push(observer);
  }

  private applySelectionOffset(offset: number): void {
    let remaining = offset;

    for (let i = 0; i < this.editors.length; i++) {
      const editor = this.editors[i];
      const size = this.getEditorContentSize(editor);

      if (remaining < size) {
        const pos = Math.min(size, Math.max(1, remaining + 1));
        editor.chain().focus().setTextSelection(pos).run();
        return;
      }

      remaining -= size;
    }

    const lastEditor = this.editors[this.editors.length - 1];
    if (lastEditor) {
      const size = this.getEditorContentSize(lastEditor);
      const pos = Math.min(size, Math.max(1, size));
      lastEditor.chain().focus().setTextSelection(pos).run();
    }
  }
}
