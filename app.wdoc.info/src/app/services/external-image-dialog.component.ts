import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

interface ExternalImageDialogData {
  src: string;
}

@Component({
  selector: 'app-external-image-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>Load external image?</h2>
    <div mat-dialog-content>
      <p>
        The image from
        <span class="url" title="{{ data.src }}">{{ data.src }}</span>
        will be loaded from an external source. Do you want to continue?
      </p>
    </div>
    <div mat-dialog-actions align="end">
      <button mat-button (click)="close(false)">Cancel</button>
      <button mat-flat-button color="primary" (click)="close(true)">Load image</button>
    </div>
  `,
  styles: [
    `
      .url {
        word-break: break-all;
        font-weight: 600;
      }
    `,
  ],
})
export class ExternalImageDialogComponent {
  constructor(
    @Inject(MAT_DIALOG_DATA) public data: ExternalImageDialogData,
    private dialogRef: MatDialogRef<ExternalImageDialogComponent, boolean>,
  ) {}

  close(confirmed: boolean): void {
    this.dialogRef.close(confirmed);
  }
}
