import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule } from '@angular/material/dialog';
import { FontTrustService } from './font-trust.service';

@Component({
  selector: 'app-font-settings', standalone: true, imports: [FormsModule, MatDialogModule], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<h2 mat-dialog-title>Font settings</h2>
    <mat-dialog-content>
      <p>Permissions apply to fonts in every document on this browser. Default providers load automatically. Preferences apply the next time a document is opened.</p>
      @for (origin of trust.sources; track origin) {
        <label class="source">{{ origin }}
          <select [attr.aria-label]="'Font policy for ' + origin" [ngModel]="trust.preferences[origin] || 'default'" (ngModelChange)="trust.set(origin, $event)">
            <option value="default">Use default policy</option><option value="allow">Always allow</option><option value="block">Always block</option>
          </select>
        </label>
      }
      <form (ngSubmit)="add()"><label>Trusted HTTPS origin<input name="origin" [(ngModel)]="origin" placeholder="https://fonts.example.com" /></label><button type="submit">Add trusted source</button></form>
      @if (error) { <p role="alert">{{ error }}</p> }
    </mat-dialog-content><mat-dialog-actions align="end"><button mat-dialog-close>Close</button></mat-dialog-actions>`,
  styles: ['.source, form label { display:grid; gap:8px; margin:16px 0; overflow-wrap:anywhere; } select, input, button { padding:8px; }'],
})
export class FontSettingsComponent {
  origin = ''; error = '';
  constructor(public trust: FontTrustService) {}
  add() { this.error = ''; try { this.trust.set(this.origin.trim(), 'allow'); this.origin = ''; } catch (error) { this.error = (error as Error).message; } }
}
