import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

export interface AlertDialogData {
  title?: string;
  message: string;
}

@Component({
  selector: 'app-alert-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title || 'Notice' }}</h2>
    <div mat-dialog-content>
      <p>{{ data.message }}</p>
    </div>
    <div mat-dialog-actions align="end">
      <button mat-flat-button color="primary" (click)="close()">OK</button>
    </div>
  `,
})
export class AlertDialogComponent {
  constructor(
    @Inject(MAT_DIALOG_DATA) public data: AlertDialogData,
    private dialogRef: MatDialogRef<AlertDialogComponent>,
  ) {}

  close(): void {
    this.dialogRef.close();
  }
}
