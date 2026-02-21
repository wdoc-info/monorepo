import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { SimpleChange } from '@angular/core';
import { ViewerComponent } from './viewer.component';

describe('ViewerComponent', () => {
  let fixture: ComponentFixture<ViewerComponent>;
  let component: ViewerComponent;
  let sanitizer: DomSanitizer;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ViewerComponent] });
    fixture = TestBed.createComponent(ViewerComponent);
    component = fixture.componentInstance;
    sanitizer = TestBed.inject(DomSanitizer);
  });

  it('creates a shadow root and renders provided HTML', () => {
    component.htmlContent = sanitizer.bypassSecurityTrustHtml(
      '<wdoc-page><p>hello</p></wdoc-page>',
    );
    fixture.detectChanges();

    component.ngAfterViewInit();

    expect(component.documentRoot).toBeDefined();
    expect(component.documentRoot?.querySelector('p')?.textContent).toBe('hello');
  });

  it('applies zoom updates when the input changes', fakeAsync(() => {
    component.htmlContent = sanitizer.bypassSecurityTrustHtml('<wdoc-page></wdoc-page>');
    fixture.detectChanges();
    component.ngAfterViewInit();

    component.zoom = 150;
    component.ngOnChanges({ zoom: new SimpleChange(100, 150, false) });
    flushMicrotasks();

    const page = component.documentRoot?.querySelector('wdoc-page') as HTMLElement;
    expect(page.style.zoom).toBe('1.5');
  }));

  it('defers rendering until the view is initialized', () => {
    component.htmlContent = sanitizer.bypassSecurityTrustHtml('<div>pending</div>');
    component.ngOnChanges({ htmlContent: new SimpleChange(null, component.htmlContent, false) });

    expect((component as any).pendingContentRender).toBeTrue();

    fixture.detectChanges();
    component.ngAfterViewInit();

    expect(component.documentRoot?.innerHTML).toContain('pending');
    expect((component as any).pendingContentRender).toBeFalse();
  });

  it('emits form interaction events from the shadow root', () => {
    const spy = jasmine.createSpy('formInteraction');
    component.formInteraction.subscribe(spy);
    component.htmlContent = sanitizer.bypassSecurityTrustHtml(
      '<wdoc-page><input type="text" value="x" /></wdoc-page>',
    );
    fixture.detectChanges();
    component.ngAfterViewInit();

    const input = component.documentRoot?.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    expect(spy).toHaveBeenCalled();
  });
});
