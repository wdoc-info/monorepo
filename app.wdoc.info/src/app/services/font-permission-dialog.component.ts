import { ChangeDetectionStrategy, Component, Inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

export type FontPermission = 'once' | 'always' | 'deny';
@Component({
  selector: 'app-font-permission-dialog', standalone: true,
  imports: [FormsModule, MatDialogModule], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Load external fonts?</h2>
    <mat-dialog-content>
      <p>This document needs fonts from these sources. Loading them contacts their servers.</p>
      @for (origin of data.origins; track origin) {
        <label class="source">{{ origin }}
          <select [attr.aria-label]="'Font permission for ' + origin" [(ngModel)]="choices[origin]">
            <option value="once">Allow for this document</option>
            <option value="always">Always allow this domain</option>
            <option value="deny">Do not load</option>
          </select>
        </label>
      }
      <p>You can change remembered permissions in Font settings.</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button type="button" (click)="dialog.close()">Cancel</button>
      <button type="button" (click)="dialog.close(choices)">Continue</button>
    </mat-dialog-actions>`,
  styles: ['.source { display: grid; gap: 8px; margin: 16px 0; overflow-wrap: anywhere; } select { padding: 8px; } button { margin: 4px; padding: 8px 12px; }'],
})
export class FontPermissionDialogComponent {
  choices: Record<string, FontPermission>;
  constructor(@Inject(MAT_DIALOG_DATA) public data: { origins: string[] }, public dialog: MatDialogRef<FontPermissionDialogComponent>) {
    this.choices = Object.fromEntries(data.origins.map(origin => [origin, 'once']));
  }
}
