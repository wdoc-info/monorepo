import {
  Component,
  ElementRef,
  EventEmitter,
  Output,
  Input,
  ViewChild,
  OnInit,
  OnDestroy,
  NgZone,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './navbar.component.html',
  styleUrls: ['./navbar.component.css'],
})
export class NavbarComponent implements OnInit, OnDestroy {
  @Output() fileSelected = new EventEmitter<File>();
  @Output() save = new EventEmitter<void>();
  @Input() showSave = false;
  @Output() closeNav = new EventEmitter<void>();
  @Output() createNewDocument = new EventEmitter<void>();
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  isAuthModalOpen = false;
  isSettingsModalOpen = false;
  otpRequested = false;
  email = '';
  otpCode = '';
  statusMessage = '';
  isSendingCode = false;
  isVerifyingCode = false;
  isSubmitting = false;
  currentUserEmail: string | null = null;
  private sessionSub?: Subscription;

  constructor(
    private authService: AuthService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.currentUserEmail = this.authService.getCurrentUserEmail();
    this.sessionSub = this.authService.session$.subscribe((session) => {
      this.currentUserEmail = session?.user?.email ?? null;
      if (!session) {
        this.resetAuthUiState();
      }
    });
  }

  ngOnDestroy(): void {
    this.sessionSub?.unsubscribe();
  }

  onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.fileSelected.emit(input.files[0]);
    }
  }

  triggerFileDialog() {
    this.fileInput?.nativeElement.click();
  }

  onCreateNewDocument(): void {
    this.createNewDocument.emit();
    this.closeNav.emit();
  }

  onCloseNav() {
    this.closeNav.emit();
  }

  openAuthModal() {
    if (this.currentUserEmail) {
      this.isSettingsModalOpen = true;
      return;
    }
    this.isAuthModalOpen = true;
    this.statusMessage = '';
    this.otpRequested = false;
    this.otpCode = '';
    this.email = this.authService.getStoredEmail() ?? '';
  }

  closeAuthModal() {
    this.isAuthModalOpen = false;
    this.isSendingCode = false;
    this.isVerifyingCode = false;
    this.otpRequested = false;
    this.otpCode = '';
    this.statusMessage = '';
  }

  closeSettingsModal() {
    this.isSettingsModalOpen = false;
  }

  async onAuthSubmit() {
    if (!this.email) {
      this.statusMessage = 'Please enter your email to continue.';
      return;
    }

    this.otpRequested = true;
    this.otpCode = '';
    this.isSendingCode = true;
    this.statusMessage = 'Sending verification code...';
    try {
      const { error } = await this.authService.signInWithEmail(this.email);
      this.ngZone.run(() => {
        if (error) {
          this.statusMessage = `${error.message} You can still enter a code if you already received one.`;
          return;
        }
        this.statusMessage = 'Enter the 6-digit verification code sent to your email.';
      });
    } catch {
      this.ngZone.run(() => {
        this.statusMessage = 'Unexpected error while sending verification code.';
      });
    } finally {
      this.ngZone.run(() => {
        this.isSendingCode = false;
        this.cdr.detectChanges();
      });
    }
  }

  async onOtpSubmit() {
    if (!this.otpCode) {
      this.statusMessage = 'Please enter the verification code.';
      return;
    }

    this.isVerifyingCode = true;
    this.statusMessage = 'Verifying code...';
    try {
      const { error } = await this.authService.verifyOtp(this.email, this.otpCode);
      this.ngZone.run(() => {
        if (error) {
          this.statusMessage = error.message;
          return;
        }

        this.currentUserEmail =
          this.authService.getCurrentUserEmail() ?? this.email.trim();
        this.isSettingsModalOpen = false;
        this.isAuthModalOpen = false;
        this.otpRequested = false;
        this.otpCode = '';
        this.statusMessage = '';
      });
    } catch {
      this.ngZone.run(() => {
        this.statusMessage = 'Unexpected error while validating verification code.';
      });
    } finally {
      this.ngZone.run(() => {
        this.isVerifyingCode = false;
        this.cdr.detectChanges();
      });
    }
  }

  resetAuthFlow() {
    this.isSendingCode = false;
    this.isVerifyingCode = false;
    this.otpRequested = false;
    this.otpCode = '';
    this.statusMessage = '';
  }

  async onLogout() {
    this.isSubmitting = true;
    await this.authService.signOut();
    this.isSubmitting = false;
    this.currentUserEmail = null;
    this.resetAuthUiState();
  }

  private resetAuthUiState() {
    this.isSettingsModalOpen = false;
    this.isAuthModalOpen = false;
    this.isSendingCode = false;
    this.isVerifyingCode = false;
    this.otpRequested = false;
    this.otpCode = '';
    this.statusMessage = '';
    this.email = '';
    this.isSubmitting = false;
  }
}
