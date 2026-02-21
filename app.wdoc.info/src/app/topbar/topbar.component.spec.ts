import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TopbarComponent } from './topbar.component';

describe('TopbarComponent', () => {
  let component: TopbarComponent;
  let fixture: ComponentFixture<TopbarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TopbarComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TopbarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('emits toggle event when hamburger clicked', () => {
    spyOn(component.toggleNav, 'emit');
    const btn = fixture.nativeElement.querySelector('.hamburger');
    btn.click();
    expect(component.toggleNav.emit).toHaveBeenCalled();
  });

  it('emits save form when save form button clicked', () => {
    component.showFormSave = true;
    fixture.detectChanges();
    spyOn(component.saveForm, 'emit');
    const btn = fixture.nativeElement.querySelector('.topbar-save');
    btn.click();
    expect(component.saveForm.emit).toHaveBeenCalled();
  });

  it('emits save document when save document button clicked', () => {
    component.showDocumentSave = true;
    component.isEditing = true;
    fixture.detectChanges();
    spyOn(component.saveDocument, 'emit');
    const buttons = fixture.nativeElement.querySelectorAll(
      '.topbar-save',
    ) as NodeListOf<HTMLButtonElement>;
    const docButton = Array.from(buttons).find((btn) =>
      btn.textContent?.includes('document'),
    );
    docButton?.click();
    expect(component.saveDocument.emit).toHaveBeenCalled();
  });

  it('renders the provided title', () => {
    component.title = 'My Document';
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement.querySelector(
      '.topbar-title'
    );
    expect(el.textContent?.trim()).toBe('My Document');
  });

  it('emits title changes when editing', () => {
    component.isEditing = true;
    fixture.detectChanges();
    spyOn(component.titleChange, 'emit');
    const input: HTMLInputElement = fixture.nativeElement.querySelector(
      '#document-title-input',
    );
    input.value = 'Updated title';
    input.dispatchEvent(new Event('input'));

    expect(component.titleChange.emit).toHaveBeenCalledWith('Updated title');
  });

  it('emits editDocument when clicking update button', () => {
    component.hasDocument = true;
    fixture.detectChanges();
    spyOn(component.editDocument, 'emit');
    const updateButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '.topbar-secondary',
    );
    updateButton.click();

    expect(component.editDocument.emit).toHaveBeenCalled();
  });

  it('emits zoomChange when zoom buttons are used', () => {
    component.hasDocument = true;
    spyOn(component.zoomChange, 'emit');
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('.zoom-button');
    (buttons[0] as HTMLButtonElement).click();
    expect(component.zoomChange.emit).toHaveBeenCalledWith(90);
  });

  it('emits parsed zoom value from input on commit', () => {
    component.hasDocument = true;
    spyOn(component.zoomChange, 'emit');
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector(
      '.zoom-input input'
    );
    input.value = '150';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    expect(component.zoomChange.emit).toHaveBeenCalledWith(150);
  });

  it('falls back to the current zoom when an invalid value is entered', () => {
    component.hasDocument = true;
    component.zoom = 85;
    spyOn(component.zoomChange, 'emit');
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector(
      '.zoom-input input'
    );
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));

    expect(component.zoomChange.emit).toHaveBeenCalledWith(85);
  });

  it('shows attachments button when data is available and lists sections', () => {
    component.attachments = [{ name: 'guide.pdf', blob: new Blob() }];
    component.formAnswers = [{ name: 'form-1.json', blob: new Blob() }];
    fixture.detectChanges();

    const btn: HTMLButtonElement = fixture.nativeElement.querySelector(
      '.attachments-button'
    );
    expect(btn).toBeTruthy();

    btn.click();
    fixture.detectChanges();

    const dropdown: HTMLElement = fixture.nativeElement.querySelector(
      '.attachments-dropdown'
    );
    expect(dropdown.textContent).toContain('Attachment(s)');
    expect(dropdown.textContent).toContain('Form answers');
    expect(dropdown.textContent).toContain('guide.pdf');
    expect(dropdown.textContent).toContain('form-1.json');
  });

  it('does not open the attachments menu when there is no attachment data', () => {
    component.attachments = [];
    component.formAnswers = [];
    fixture.detectChanges();

    component.attachmentsMenuOpen = true;
    component.toggleAttachmentsMenu();

    expect(component.attachmentsMenuOpen).toBeFalse();
  });

  it('downloads files using blob URLs', () => {
    component.attachments = [{ name: 'guide.pdf', blob: new Blob(['123']) }];
    fixture.detectChanges();
    const createUrlSpy = spyOn(URL, 'createObjectURL').and.returnValue('blob:123');
    const revokeSpy = spyOn(URL, 'revokeObjectURL');
    const realCreateElement = document.createElement.bind(document);
    let anchor: HTMLAnchorElement | undefined;
    const anchorSpy = spyOn(document, 'createElement').and.callFake((tag: string) => {
      if (tag === 'a') {
        anchor = realCreateElement(tag) as HTMLAnchorElement;
        spyOn(anchor, 'click');
        return anchor;
      }
      return realCreateElement(tag);
    });

    component.downloadFile(component.attachments[0]);

    expect(createUrlSpy).toHaveBeenCalled();
    expect(anchorSpy).toHaveBeenCalledWith('a');
    expect(anchor!.download).toBe('guide.pdf');
    expect(anchor!.click).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalledWith('blob:123');
  });
});
