import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { AlertDialogComponent } from './alert-dialog.component';
import { LoadingDialogComponent } from './loading-dialog.component';

@Injectable({ providedIn: 'root' })
export class DialogService {
  constructor(private dialog: MatDialog) {}

  openAlert(message: string, title?: string): Promise<void> {
    const dialogRef = this.dialog.open(AlertDialogComponent, {
      data: { message, title },
      width: '360px',
    });

    return firstValueFrom(dialogRef.afterClosed());
  }

  openLoading(message = 'Please wait...'): () => void {
    const dialogRef = this.dialog.open(LoadingDialogComponent, {
      data: { message },
      disableClose: true,
      width: '360px',
    });

    return () => dialogRef.close();
  }
}
