# wdoc-backend

Minimal passwordless authentication API for wdoc built on Bun + Hono + SQLite.

## Setup

```bash
bun install
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| PORT | 3000 | Server port |
| DATABASE_URL | ./data/dev.db | SQLite database path |
| CORS_ORIGINS | http://localhost:4200,https://app.wdoc.info | Comma-separated allowed origins |
| JWT_SECRET | dev-jwt-secret | Secret used to sign JWTs |
| JWT_EXPIRES_IN_SECONDS | 604800 | JWT expiration (seconds) |
| OTP_EXPIRES_IN_MINUTES | 10 | OTP expiration (minutes) |
| OTP_HASH_SECRET | JWT_SECRET | Secret used to hash OTPs |
| LOCKOUT_MINUTES | 10 | Lockout duration after failed attempts |
| EMAIL_PROVIDER | console | Email provider: `console` or `ses` |
| EMAIL_FROM | no-reply@wdoc.local | Email from address |
| RATE_LIMIT_WINDOW_MS | 600000 | Rate limit window in ms |
| RATE_LIMIT_MAX | 5 | Max `/login` requests per window |
| AWS_ACCESS_KEY_ID |  | SES credentials (if using SES) |
| AWS_SECRET_ACCESS_KEY |  | SES credentials (if using SES) |
| AWS_REGION |  | SES region (if using SES) |

## Run locally

```bash
bun run dev
```

## API usage

### Request OTP

```bash
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

### Validate OTP

```bash
curl -X POST http://localhost:3000/loginvalidate \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","code":"123456"}'
```

## Tests

```bash
bun test
```
