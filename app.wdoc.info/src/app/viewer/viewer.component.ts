import {
  Component,
  Input,
  AfterViewInit,
  ElementRef,
  ViewChild,
  OnChanges,
  SimpleChanges,
  ChangeDetectionStrategy,
  Output,
  EventEmitter,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SecurityContext } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'app-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './viewer.component.html',
  styleUrls: ['./viewer.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewerComponent implements AfterViewInit, OnChanges {
  @Input() htmlContent: SafeHtml | null = null;
  @Input() zoom = 100;
  @Output() formInteraction = new EventEmitter<void>();
  @ViewChild('contentContainer') contentContainer?: ElementRef;
  @ViewChild('scrollContainer') scrollContainer?: ElementRef;
  private viewInitialized = false;
  private pendingZoomRefresh = false;
  private pendingContentRender = false;
  private shadowRoot?: ShadowRoot;

  constructor(private sanitizer: DomSanitizer) {}

  ngAfterViewInit() {
    this.createShadowRoot();
    this.viewInitialized = true;
    this.renderContent();
    this.applyZoom();
    if (this.pendingZoomRefresh) {
      this.pendingZoomRefresh = false;
      this.scheduleZoomRefresh();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['zoom'] && this.viewInitialized) {
      this.applyZoom();
    }
    if (changes['htmlContent'] && this.viewInitialized) {
      this.renderContent();
      this.scheduleZoomRefresh();
    } else if (changes['htmlContent']) {
      this.pendingZoomRefresh = true;
      this.pendingContentRender = true;
    }
  }

  get nativeElement(): HTMLElement | undefined {
    return this.contentContainer?.nativeElement as HTMLElement;
  }

  get documentRoot(): ShadowRoot | undefined {
    return this.shadowRoot;
  }

  onFormInteraction(): void {
    this.formInteraction.emit();
  }

  private applyZoom() {
    const root = this.shadowRoot;
    if (!root) {
      return;
    }
    const scale = Math.max(10, this.zoom) / 100;

    const pages = Array.from(root.querySelectorAll('wdoc-page')) as HTMLElement[];

    pages.forEach((page) => {
      page.style.zoom = `${scale}`;
    });
  }

  private scheduleZoomRefresh(): void {
    queueMicrotask(() => this.applyZoom());
  }

  private createShadowRoot(): void {
    const host = this.contentContainer?.nativeElement as HTMLElement | null;
    if (!host || this.shadowRoot) {
      return;
    }
    this.shadowRoot = host.attachShadow({ mode: 'open' });
    this.shadowRoot.addEventListener('input', () => this.onFormInteraction());
    this.shadowRoot.addEventListener('change', () => this.onFormInteraction());
  }

  private renderContent(): void {
    if (!this.shadowRoot) {
      this.pendingContentRender = true;
      return;
    }

    if (this.pendingContentRender) {
      this.pendingContentRender = false;
    }

    const htmlString = this.htmlContent
      ? this.sanitizer.sanitize(SecurityContext.HTML, this.htmlContent)
      : '';
    this.shadowRoot.innerHTML = htmlString ?? '';
  }
}
