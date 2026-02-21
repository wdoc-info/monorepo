import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ExternalImageDialogComponent } from './external-image-dialog.component';

describe('ExternalImageDialogComponent', () => {
  let fixture: ComponentFixture<ExternalImageDialogComponent>;
  let dialogRefSpy: jasmine.SpyObj<MatDialogRef<ExternalImageDialogComponent, boolean>>;

  beforeEach(() => {
    dialogRefSpy = jasmine.createSpyObj('MatDialogRef', ['close']);

    TestBed.configureTestingModule({
      imports: [ExternalImageDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { src: 'https://cdn.example.com/cat.png' } },
        { provide: MatDialogRef, useValue: dialogRefSpy },
      ],
    });

    fixture = TestBed.createComponent(ExternalImageDialogComponent);
    fixture.detectChanges();
  });

  it('displays the external image url', () => {
    const urlElement = fixture.nativeElement.querySelector('.url');
    expect(urlElement.textContent.trim()).toBe('https://cdn.example.com/cat.png');
  });

  it('returns false when cancel is clicked', () => {
    const cancelButton: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    cancelButton.click();

    expect(dialogRefSpy.close).toHaveBeenCalledWith(false);
  });

  it('returns true when confirm is clicked', () => {
    const confirmButton: HTMLButtonElement = fixture.nativeElement.querySelectorAll('button')[1];
    confirmButton.click();

    expect(dialogRefSpy.close).toHaveBeenCalledWith(true);
  });
});
