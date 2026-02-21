import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-loading-dialog',
  standalone: true,
  imports: [MatDialogModule, MatProgressSpinnerModule],
  template: `
    <div class="loading-dialog" aria-live="polite">
      <div class="loading-dialog__body">
        <mat-progress-spinner mode="indeterminate" diameter="48"></mat-progress-spinner>
        <div class="loading-dialog__text">{{ data?.message || 'Please wait' }}</div>
      </div>
    </div>
  `,
  styles: [
    `
      .loading-dialog {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 280px;
        min-height: 140px;
        padding: 12px;
      }
      .loading-dialog__body {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 16px;
        align-items: center;
      }
      .loading-dialog__text {
        font-size: 15px;
        line-height: 1.4;
      }
    `,
  ],
})
export class LoadingDialogComponent {
  constructor(
    @Inject(MAT_DIALOG_DATA)
    public data: {
      message?: string;
    },
  ) {}
}
