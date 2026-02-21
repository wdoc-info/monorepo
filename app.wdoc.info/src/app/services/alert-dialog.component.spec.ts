import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { AlertDialogComponent } from './alert-dialog.component';

describe('AlertDialogComponent', () => {
  let fixture: ComponentFixture<AlertDialogComponent>;
  let dialogRefSpy: jasmine.SpyObj<MatDialogRef<AlertDialogComponent>>;

  beforeEach(() => {
    dialogRefSpy = jasmine.createSpyObj('MatDialogRef', ['close']);

    TestBed.configureTestingModule({
      imports: [AlertDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { message: 'Hello world' } },
        { provide: MatDialogRef, useValue: dialogRefSpy },
      ],
    });

    fixture = TestBed.createComponent(AlertDialogComponent);
    fixture.detectChanges();
  });

  it('shows a default title when none is provided', () => {
    const title = fixture.nativeElement.querySelector('h2');
    expect(title.textContent.trim()).toBe('Notice');
  });

  it('renders the provided message', () => {
    const paragraph = fixture.nativeElement.querySelector('p');
    expect(paragraph.textContent?.trim()).toBe('Hello world');
  });

  it('closes the dialog when the action button is clicked', () => {
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    button.click();

    expect(dialogRefSpy.close).toHaveBeenCalled();
  });
});
