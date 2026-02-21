import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { NavbarComponent } from './navbar.component';
import { AuthService, AuthSession } from '../services/auth.service';

class MockAuthService {
  private sessionSubject = new BehaviorSubject<AuthSession | null>(null);
  private storedEmail: string | null = null;
  session$ = this.sessionSubject.asObservable();
  getStoredEmail = jasmine
    .createSpy('getStoredEmail')
    .and.callFake(() => this.storedEmail);
  getCurrentUserEmail = jasmine
    .createSpy('getCurrentUserEmail')
    .and.callFake(() => this.sessionSubject.getValue()?.user.email ?? null);
  signInWithEmail = jasmine
    .createSpy('signInWithEmail')
    .and.callFake(() => Promise.resolve({ error: null }));
  verifyOtp = jasmine.createSpy('verifyOtp').and.callFake((email: string) => {
    const session: AuthSession = {
      token: 'token',
      user: { id: 'user-id', email },
    };
    this.emitSession(session);
    return Promise.resolve({ error: null });
  });
  signOut = jasmine
    .createSpy('signOut')
    .and.callFake(() => {
      this.emitSession(null);
      return Promise.resolve({ error: null });
    });

  emitSession(session: AuthSession | null) {
    this.storedEmail = session?.user.email ?? null;
    this.sessionSubject.next(session);
  }
}

describe('NavbarComponent', () => {
  let fixture: ComponentFixture<NavbarComponent>;
  let component: NavbarComponent;
  let authService: MockAuthService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NavbarComponent],
      providers: [{ provide: AuthService, useClass: MockAuthService }],
    }).compileComponents();

    fixture = TestBed.createComponent(NavbarComponent);
    component = fixture.componentInstance;
    authService = TestBed.inject(AuthService) as unknown as MockAuthService;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should emit selected file', () => {
    const file = new File(['dummy'], 'test.zip');
    let emitted: File | null = null;
    component.fileSelected.subscribe((f) => (emitted = f));

    const mockEvent = { target: { files: [file] } } as unknown as Event;
    component.onFileChange(mockEvent);

    expect(emitted).toBeTruthy();
    expect(emitted!.name).toBe('test.zip');
  });

  it('should open settings modal when session already exists', () => {
    authService.emitSession({ token: 'token', user: { id: 'u1', email: 'stored@example.com' } });
    component.openAuthModal();

    expect(component.isSettingsModalOpen).toBeTrue();
  });

  it('should open auth modal with stored email when no active session', () => {
    authService.getStoredEmail.and.returnValue('stored@example.com');
    component.currentUserEmail = null;

    component.openAuthModal();

    expect(component.isAuthModalOpen).toBeTrue();
    expect(component.email).toBe('stored@example.com');
    expect(component.statusMessage).toBe('');
    expect(component.otpRequested).toBeFalse();
  });

  it('should open settings modal when user already logged in', () => {
    component.currentUserEmail = 'user@example.com';

    component.openAuthModal();

    expect(component.isSettingsModalOpen).toBeTrue();
    expect(component.isAuthModalOpen).toBeFalse();
  });

  it('should show validation message when no email provided', async () => {
    component.email = '';
    await component.onAuthSubmit();

    expect(component.statusMessage).toContain('Please enter your email');
    expect(authService.signInWithEmail).not.toHaveBeenCalled();
    expect(component.isSubmitting).toBeFalse();
  });

  it('should display error when sending code fails', async () => {
    const error = { message: 'failed to send' };
    authService.signInWithEmail.and.returnValue(Promise.resolve({ error } as any));
    component.email = 'user@example.com';

    await component.onAuthSubmit();

    expect(authService.signInWithEmail).toHaveBeenCalledWith('user@example.com');
    expect(component.statusMessage).toContain('failed to send');
    expect(component.currentUserEmail).toBeNull();
    expect(component.otpRequested).toBeTrue();
    expect(component.isSubmitting).toBeFalse();
  });

  it('should set OTP step when sending code succeeds', async () => {
    component.email = 'user@example.com';

    await component.onAuthSubmit();

    expect(authService.signInWithEmail).toHaveBeenCalledWith('user@example.com');
    expect(component.statusMessage).toContain('6-digit verification code');
    expect(component.currentUserEmail).toBeNull();
    expect(component.isSubmitting).toBeFalse();
    expect(component.otpRequested).toBeTrue();
  });

  it('should show validation message when no OTP code is provided', async () => {
    component.otpRequested = true;
    component.otpCode = '';

    await component.onOtpSubmit();

    expect(authService.verifyOtp).not.toHaveBeenCalled();
    expect(component.statusMessage).toContain('Please enter the verification code');
  });

  it('should display error when OTP verification fails', async () => {
    const error = { message: 'invalid code' };
    authService.verifyOtp.and.returnValue(Promise.resolve({ error } as any));
    component.isAuthModalOpen = true;
    component.email = 'user@example.com';
    component.otpRequested = true;
    component.otpCode = '000000';

    await component.onOtpSubmit();

    expect(authService.verifyOtp).toHaveBeenCalledWith('user@example.com', '000000');
    expect(component.statusMessage).toBe('invalid code');
    expect(component.isAuthModalOpen).toBeTrue();
  });

  it('should complete login when OTP verification succeeds', async () => {
    component.isAuthModalOpen = true;
    component.email = 'user@example.com';
    component.otpRequested = true;
    component.otpCode = '123456';

    await component.onOtpSubmit();

    expect(authService.verifyOtp).toHaveBeenCalledWith('user@example.com', '123456');
    expect(component.currentUserEmail).toBe('user@example.com');
    expect(component.isAuthModalOpen).toBeFalse();
    expect(component.otpRequested).toBeFalse();
  });

  it('should clear auth state on logout', async () => {
    component.currentUserEmail = 'user@example.com';
    component.isSettingsModalOpen = true;

    await component.onLogout();

    expect(authService.signOut).toHaveBeenCalled();
    expect(component.currentUserEmail).toBeNull();
    expect(component.statusMessage).toBe('');
    expect(component.isSubmitting).toBeFalse();
    expect(component.isSettingsModalOpen).toBeFalse();
  });

  it('should update current user when session changes', () => {
    authService.emitSession({
      token: 'token',
      user: { id: 'session-id', email: 'session@example.com' },
    });
    expect(component.currentUserEmail).toBe('session@example.com');
  });
});
