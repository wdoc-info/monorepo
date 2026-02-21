import { Hono } from "hono";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import type { ZodTypeAny } from "zod";
import { loadConfig, type AppConfig } from "./config";
import { initDatabase, type DatabaseClient } from "./db";
import { buildEmailSender } from "./email";
import { loginSchema, loginValidateSchema } from "./validation";
import { generateOtpCode, hashOtpCode, verifyOtpCode } from "./auth/otp";
import { signJwt } from "./auth/jwt";
import { SimpleRateLimiter } from "./rateLimit";

export type AppDependencies = {
  config: AppConfig;
  db: DatabaseClient;
  sendEmail: ReturnType<typeof buildEmailSender>;
  rateLimiter: SimpleRateLimiter;
};

export const createApp = (deps?: Partial<AppDependencies>) => {
  const config = deps?.config ?? loadConfig();
  const db = deps?.db ?? initDatabase(config.databaseUrl);
  const sendEmail = deps?.sendEmail ?? buildEmailSender(config);
  const rateLimiter = deps?.rateLimiter ?? new SimpleRateLimiter(config.rateLimitWindowMs, config.rateLimitMax);

  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: config.corsOrigins,
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );
  const jsonValidator = <T,>(schema: ZodTypeAny) =>
    zValidator("json", schema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: { code: "INVALID_REQUEST", message: "Invalid request body." } },
          400,
        );
      }
      return result.data as T;
    });

  app.post("/login", jsonValidator(loginSchema), async (c) => {
    const { email } = c.req.valid("json");
    const now = Date.now();
    const rateKey = `${email}:${c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown"}`;
    const rate = rateLimiter.check(rateKey, now);
    if (!rate.allowed) {
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests. Try again later.",
          },
        },
        429,
      );
    }

    let user = db.getUserByEmail(email);
    if (!user) {
      user = db.createUser(crypto.randomUUID(), email, now);
    } else {
      db.updateUserTouched(user.id, now);
    }

    if (user.locked_until && user.locked_until > now) {
      return c.json(
        {
          error: {
            code: "LOCKED",
            message: "Try again later.",
          },
        },
        429,
      );
    }

    db.invalidateActiveCodes(user.id, now);
    const code = generateOtpCode();
    const expiresAt = now + config.otpExpiresInMinutes * 60 * 1000;
    const codeHash = hashOtpCode(config.otpHashSecret, code);
    db.createLoginCode({
      id: crypto.randomUUID(),
      user_id: user.id,
      code_hash: codeHash,
      created_at: now,
      expires_at: expiresAt,
      invalidated_at: null,
      attempts: 0,
    });

    const minutes = config.otpExpiresInMinutes;
    await sendEmail({
      to: email,
      subject: "Your wdoc login code",
      text: `Your wdoc verification code is ${code}. It expires in ${minutes} minutes.`,
    });

    return c.json({ ok: true });
  });

  app.post("/loginvalidate", jsonValidator(loginValidateSchema), async (c) => {
    const { email, code } = c.req.valid("json");
    const now = Date.now();
    const user = db.getUserByEmail(email);

    if (!user) {
      return c.json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or code.",
          },
        },
        401,
      );
    }

    if (user.locked_until && user.locked_until > now) {
      return c.json(
        {
          error: {
            code: "LOCKED",
            message: "Try again later.",
          },
        },
        429,
      );
    }

    const activeCode = db.getActiveLoginCode(user.id, now);
    if (!activeCode) {
      return c.json(
        {
          error: {
            code: "INVALID_CODE",
            message: "Invalid email or code.",
          },
        },
        401,
      );
    }

    const valid = verifyOtpCode(config.otpHashSecret, code, activeCode.code_hash);
    if (!valid) {
      const updated = db.incrementAttempts(activeCode.id);
      if (updated && updated.attempts >= 3) {
        db.invalidateCode(activeCode.id, now);
        db.updateUserLock(user.id, now + config.lockoutMinutes * 60 * 1000, now);
      }
      return c.json(
        {
          error: {
            code: "INVALID_CODE",
            message: "Invalid email or code.",
          },
        },
        401,
      );
    }

    db.invalidateCode(activeCode.id, now);
    db.updateUserLock(user.id, null, now);

    const token = await signJwt(
      { sub: user.id, email: user.email },
      config.jwtSecret,
      config.jwtExpiresInSeconds,
    );

    return c.json({
      token,
      user: {
        id: user.id,
        email: user.email,
      },
    });
  });

  return app;
};
