import { TestBed } from '@angular/core/testing';
import { backendConfig } from '../config/app.config';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  });

  it('loads the stored session and email from localStorage', () => {
    localStorage.setItem(
      'wdoc-auth-session',
      JSON.stringify({
        token: 'jwt-token',
        user: { id: 'user-id', email: 'person@example.com' },
      })
    );

    service = TestBed.inject(AuthService);

    expect(service.getStoredEmail()).toBe('person@example.com');
    expect(service.getCurrentSession()?.token).toBe('jwt-token');
  });

  it('sends an OTP request and persists the email', async () => {
    service = TestBed.inject(AuthService);

    const result = await service.signInWithEmail('another@example.com');

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith(`${backendConfig.authApiUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'another@example.com' }),
    });
    expect(service.getStoredEmail()).toBe('another@example.com');
  });

  it('stores session after OTP verification', async () => {
    fetchSpy.and.callFake((input: RequestInfo | URL) => {
      if (String(input).endsWith('/loginvalidate')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'signed-token',
              user: { id: 'user-id', email: 'verified@example.com' },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    service = TestBed.inject(AuthService);
    const result = await service.verifyOtp('verified@example.com', '123456');

    expect(result.error).toBeNull();
    expect(service.getCurrentUserEmail()).toBe('verified@example.com');
    expect(service.getCurrentSession()?.token).toBe('signed-token');
  });

  it('clears stored email and session on sign out', async () => {
    localStorage.setItem('wdoc-auth-email', 'saved@example.com');
    localStorage.setItem(
      'wdoc-auth-session',
      JSON.stringify({
        token: 'jwt-token',
        user: { id: 'user-id', email: 'saved@example.com' },
      })
    );
    service = TestBed.inject(AuthService);

    await service.signOut();

    expect(localStorage.getItem('wdoc-auth-email')).toBeNull();
    expect(localStorage.getItem('wdoc-auth-session')).toBeNull();
    expect(service.getCurrentSession()).toBeNull();
  });

  it('returns null current user when no session is available', () => {
    localStorage.setItem('wdoc-auth-email', 'remembered@example.com');
    service = TestBed.inject(AuthService);

    expect(service.getCurrentUserEmail()).toBeNull();
    expect(service.getStoredEmail()).toBe('remembered@example.com');
  });

  it('surfaces backend error responses', async () => {
    fetchSpy.and.returnValue(
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 'INVALID_CODE', message: 'Invalid email or code.' },
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );

    service = TestBed.inject(AuthService);
    const result = await service.verifyOtp('person@example.com', '999999');

    expect(result.error?.message).toBe('Invalid email or code.');
    expect(result.error?.code).toBe('INVALID_CODE');
  });
});
