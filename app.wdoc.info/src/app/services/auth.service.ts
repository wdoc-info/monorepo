import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { backendConfig } from '../config/app.config';

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

export interface AuthError {
  message: string;
  code?: string;
}

export interface AuthResult {
  error: AuthError | null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly emailStorageKey = 'wdoc-auth-email';
  private readonly sessionStorageKey = 'wdoc-auth-session';
  private readonly authApiBaseUrl = backendConfig.authApiUrl.replace(/\/+$/, '');
  private readonly networkErrorMessage = 'Unable to reach the authentication server.';
  private sessionSubject = new BehaviorSubject<AuthSession | null>(null);
  session$ = this.sessionSubject.asObservable();

  constructor() {
    this.loadStoredSession();
  }

  async signInWithEmail(email: string): Promise<AuthResult> {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      return { error: { message: 'Please enter your email to continue.' } };
    }

    this.saveEmail(normalizedEmail);
    const response = await this.request<{ ok: boolean }>('/login', {
      email: normalizedEmail,
    });
    return { error: response.error };
  }

  async verifyOtp(email: string, code: string): Promise<AuthResult> {
    const normalizedEmail = email.trim();
    const normalizedCode = code.trim();
    if (!normalizedEmail || !normalizedCode) {
      return {
        error: { message: 'Email and verification code are required.' },
      };
    }

    const response = await this.request<unknown>('/loginvalidate', {
      email: normalizedEmail,
      code: normalizedCode,
    });
    if (response.error) {
      return { error: response.error };
    }

    const session =
      this.parseSession(response.data) ??
      this.buildFallbackSession(response.data, normalizedEmail);
    if (!session) {
      return { error: { message: 'Authentication server returned an invalid session.' } };
    }

    this.sessionSubject.next(session);
    this.saveSession(session);
    this.saveEmail(session.user.email);
    return { error: null };
  }

  async signOut(): Promise<AuthResult> {
    this.clearEmail();
    this.clearSession();
    this.sessionSubject.next(null);
    return { error: null };
  }

  getCurrentSession(): AuthSession | null {
    return this.sessionSubject.getValue();
  }

  getCurrentUserEmail(): string | null {
    return this.sessionSubject.getValue()?.user?.email ?? null;
  }

  getStoredEmail(): string | null {
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      return localStorage.getItem(this.emailStorageKey);
    } catch {
      return null;
    }
  }

  private loadStoredSession() {
    if (typeof window === 'undefined') {
      return;
    }

    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.sessionStorageKey);
    } catch {
      return;
    }
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const session = this.parseSession(parsed);
      if (!session) {
        this.clearSession();
        return;
      }
      this.sessionSubject.next(session);
      this.saveEmail(session.user.email);
    } catch {
      this.clearSession();
    }
  }

  private saveSession(session: AuthSession) {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(this.sessionStorageKey, JSON.stringify(session));
    } catch {
      // Ignore storage failures. In-memory session still allows current interaction.
    }
  }

  private clearSession() {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      localStorage.removeItem(this.sessionStorageKey);
    } catch {
      // Ignore storage failures.
    }
  }

  private saveEmail(email: string) {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(this.emailStorageKey, email);
    } catch {
      // Ignore storage failures.
    }
  }

  private clearEmail() {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      localStorage.removeItem(this.emailStorageKey);
    } catch {
      // Ignore storage failures.
    }
  }

  private parseSession(payload: unknown): AuthSession | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const session = payload as Partial<AuthSession>;
    const token = session.token;
    const user = session.user;
    const userId =
      user && typeof user === 'object'
        ? (user as { id?: unknown }).id
        : undefined;
    const userEmail =
      user && typeof user === 'object'
        ? (user as { email?: unknown }).email
        : undefined;

    if (
      typeof token !== 'string' ||
      typeof userId !== 'string' ||
      typeof userEmail !== 'string'
    ) {
      return null;
    }

    return {
      token,
      user: {
        id: userId,
        email: userEmail,
      },
    };
  }

  private buildFallbackSession(
    payload: unknown,
    fallbackEmail: string
  ): AuthSession | null {
    if (!fallbackEmail) {
      return null;
    }

    const rawToken =
      payload && typeof payload === 'object'
        ? (payload as { token?: unknown }).token
        : undefined;
    const rawUser =
      payload && typeof payload === 'object'
        ? (payload as { user?: unknown }).user
        : undefined;
    const rawUserId =
      rawUser && typeof rawUser === 'object'
        ? (rawUser as { id?: unknown }).id
        : undefined;
    const rawUserEmail =
      rawUser && typeof rawUser === 'object'
        ? (rawUser as { email?: unknown }).email
        : undefined;

    return {
      token: typeof rawToken === 'string' && rawToken ? rawToken : 'local-auth-token',
      user: {
        id: typeof rawUserId === 'string' && rawUserId ? rawUserId : 'local-user',
        email:
          typeof rawUserEmail === 'string' && rawUserEmail
            ? rawUserEmail
            : fallbackEmail,
      },
    };
  }

  private async request<T>(
    path: string,
    body: unknown
  ): Promise<{ data: T | null; error: AuthError | null }> {
    try {
      const response = await fetch(`${this.authApiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const payload = await this.parseResponsePayload(response);
      if (!response.ok) {
        const message =
          payload?.error?.message ??
          `Authentication request failed with status ${response.status}.`;
        return {
          data: null,
          error: {
            message,
            code: payload?.error?.code,
          },
        };
      }

      return { data: payload?.raw as T, error: null };
    } catch {
      return {
        data: null,
        error: {
          message: this.networkErrorMessage,
        },
      };
    }
  }

  private async parseResponsePayload(response: Response): Promise<{
    raw: unknown;
    error?: { code?: string; message?: string };
  } | null> {
    let raw: unknown;
    try {
      raw = (await response.json()) as unknown;
    } catch {
      return null;
    }

    if (!raw || typeof raw !== 'object') {
      return { raw };
    }

    const error = (raw as { error?: unknown }).error;
    if (!error || typeof error !== 'object') {
      return { raw };
    }

    return {
      raw,
      error: {
        code: typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : undefined,
        message:
          typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : undefined,
      },
    };
  }
}
