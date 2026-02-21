import { TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';
import { AlertDialogComponent } from './alert-dialog.component';
import { DialogService } from './dialog.service';

describe('DialogService', () => {
  let service: DialogService;
  let openSpy: jasmine.Spy;

  beforeEach(() => {
    const matDialogRef = { afterClosed: () => of(undefined) } as MatDialogRef<AlertDialogComponent>;
    openSpy = jasmine.createSpy('open').and.returnValue(matDialogRef);

    TestBed.configureTestingModule({
      providers: [DialogService, { provide: MatDialog, useValue: { open: openSpy } }],
    });

    service = TestBed.inject(DialogService);
  });

  it('opens an alert dialog with the provided data', async () => {
    await service.openAlert('Important message', 'Heads up');

    expect(openSpy).toHaveBeenCalledWith(AlertDialogComponent, {
      data: { message: 'Important message', title: 'Heads up' },
      width: '360px',
    });
  });
});
