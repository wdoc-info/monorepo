export type AppConfig = {
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  jwtSecret: string;
  jwtExpiresInSeconds: number;
  otpExpiresInMinutes: number;
  otpHashSecret: string;
  lockoutMinutes: number;
  emailProvider: string;
  emailFrom: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
};

const readNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readCorsOrigins = (value: string | undefined): string[] => {
  const defaults = ["http://localhost:4200", "https://app.wdoc.info"];
  if (!value) {
    return defaults;
  }

  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : defaults;
};

export const loadConfig = (): AppConfig => {
  const jwtSecret = process.env.JWT_SECRET || "dev-jwt-secret";
  return {
    port: readNumber(process.env.PORT, 3000),
    databaseUrl: process.env.DATABASE_URL || "./data/dev.db",
    corsOrigins: readCorsOrigins(process.env.CORS_ORIGINS),
    jwtSecret,
    jwtExpiresInSeconds: readNumber(process.env.JWT_EXPIRES_IN_SECONDS, 60 * 60 * 24 * 7),
    otpExpiresInMinutes: readNumber(process.env.OTP_EXPIRES_IN_MINUTES, 10),
    otpHashSecret: process.env.OTP_HASH_SECRET || jwtSecret,
    lockoutMinutes: readNumber(process.env.LOCKOUT_MINUTES, 10),
    emailProvider: process.env.EMAIL_PROVIDER || "console",
    emailFrom: process.env.EMAIL_FROM || "no-reply@wdoc.local",
    rateLimitWindowMs: readNumber(process.env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
    rateLimitMax: readNumber(process.env.RATE_LIMIT_MAX, 5),
  };
};
