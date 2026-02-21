import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LoadedFile } from '../services/wdoc-loader.service';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './topbar.component.html',
  styleUrls: ['./topbar.component.css'],
})
export class TopbarComponent implements OnChanges {
  @Input() showFormSave = false;
  @Input() showDocumentSave = false;
  @Input() navOpen = false;
  @Input() title = 'WDOC viewer';
  @Input() isEditing = false;
  @Input() zoom = 100;
  @Input() hasDocument = false;
  @Input() attachments: LoadedFile[] = [];
  @Input() formAnswers: LoadedFile[] = [];
  @Output() toggleNav = new EventEmitter<void>();
  @Output() saveForm = new EventEmitter<void>();
  @Output() saveDocument = new EventEmitter<void>();
  @Output() editDocument = new EventEmitter<void>();
  @Output() titleChange = new EventEmitter<string>();
  @Output() zoomChange = new EventEmitter<number>();
  zoomValue = '100';
  attachmentsMenuOpen = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['zoom']) {
      this.zoomValue = `${this.zoom}`;
    }
    if (
      changes['attachments'] ||
      changes['formAnswers'] ||
      changes['hasDocument']
    ) {
      if (!this.hasAttachmentData) {
        this.attachmentsMenuOpen = false;
      }
    }
  }

  onToggleNav() {
    this.toggleNav.emit();
  }

  onSaveForm() {
    this.saveForm.emit();
  }

  onSaveDocument() {
    this.saveDocument.emit();
  }

  onZoomInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.zoomValue = value.replace(/\D+/g, '');
  }

  onZoomCommit() {
    const parsed = parseInt(this.zoomValue, 10);
    this.zoomChange.emit(Number.isFinite(parsed) ? parsed : this.zoom);
  }

  onZoomStep(delta: number) {
    this.zoomChange.emit(this.zoom + delta);
  }

  toggleAttachmentsMenu(): void {
    if (!this.hasAttachmentData) {
      this.attachmentsMenuOpen = false;
      return;
    }
    this.attachmentsMenuOpen = !this.attachmentsMenuOpen;
  }

  onEditDocument(): void {
    this.editDocument.emit();
  }

  onTitleChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.titleChange.emit(value);
  }

  downloadFile(file: LoadedFile): void {
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  get hasAttachmentData(): boolean {
    return (
      (this.attachments && this.attachments.length > 0) ||
      (this.formAnswers && this.formAnswers.length > 0)
    );
  }
}
