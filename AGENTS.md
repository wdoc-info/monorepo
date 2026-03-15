# Agent Guide: wdoc Monorepo

This repo contains four previously separate projects. Keep changes scoped to the relevant subrepo unless a cross-repo change is explicitly requested.

## Directory map

- `app.wdoc.info/`: Angular 20 viewer/editor for `.wdoc` files (main product UI).
- `backend.wdoc.info/`: Bun/Hono auth API (OTP + JWT + SQLite).
- `www.wdoc.info/`: Astro marketing site and blog.
- `examples.wdoc.info/`: `.wdoc` fixtures and unpacked HTML test content.

## Fast orientation

### `app.wdoc.info` key files

- `app.wdoc.info/src/app/app.component.ts`: main orchestration (load, render, edit, export).
- `app.wdoc.info/src/app/services/wdoc-loader.service.ts`: archive loading/parsing.
- `app.wdoc.info/src/app/services/html-processing.service.ts`: sanitization + HTML processing.
- `app.wdoc.info/src/app/services/document-creator.service.ts`: build/export `.wdoc`.
- `app.wdoc.info/src/app/services/form-manager.service.ts`: form state persistence.
- `app.wdoc.info/src/app/services/auth.service.ts`: passwordless auth (email OTP + JWT).
- `app.wdoc.info/src/app/pagination/html-pages/`: pagination logic (HtmlPageSplitter).
- `app.wdoc.info/src/app/editor/document-editor.component.ts`: TipTap rich text editor.
- `app.wdoc.info/src/app/viewer/viewer.component.ts`: Shadow DOM renderer with zoom.
- `app.wdoc.info/src/app/config/`: environment configs (dev vs prod).
- `app.wdoc.info/karma.conf.js`: test runner config with coverage thresholds.
- `app.wdoc.info/angular.json`: build configs (prod file replacement, budgets, PWA).

### `backend.wdoc.info` key files

- `backend.wdoc.info/src/app.ts`: Hono routes (`/login`, `/loginvalidate`).
- `backend.wdoc.info/src/db.ts`: SQLite schema (users, login_codes) and prepared statements.
- `backend.wdoc.info/src/config.ts`: environment parsing/defaults.
- `backend.wdoc.info/src/auth/jwt.ts`: JWT signing (jose library).
- `backend.wdoc.info/src/auth/otp.ts`: OTP generation, hashing, verification.
- `backend.wdoc.info/src/validation.ts`: Zod request schemas.
- `backend.wdoc.info/src/rateLimit.ts`: in-memory window-based rate limiter.
- `backend.wdoc.info/src/email/`: email provider abstraction (console/SES).
- `backend.wdoc.info/src/tests/auth.test.ts`: auth behavior tests.

### `www.wdoc.info` key files

- `www.wdoc.info/src/pages/index.astro`: landing page.
- `www.wdoc.info/src/pages/blog/index.astro`: blog listing.
- `www.wdoc.info/src/layouts/Layout.astro`: site shell.
- `www.wdoc.info/src/styles/global.css`: global style rules.

### `examples.wdoc.info` key files

- `examples.wdoc.info/unit_test/*.wdoc`: functional fixtures.
- `examples.wdoc.info/security/*.wdoc`: security-focused fixtures.
- `examples.wdoc.info/unpacked/`: raw HTML samples.

## Local commands

### App

```bash
cd app.wdoc.info
npm install
npm start                    # dev server :4200
npm test                     # unit tests Karma/Jasmine
npm test -- --watch=false --browsers=ChromeHeadlessNoSandbox --code-coverage
npm run e2e                  # Playwright e2e
npm run build -- --configuration=production
```

### Backend

```bash
cd backend.wdoc.info
bun install
bun run dev                  # dev server :3000 (watch mode)
bun test                     # unit/integration tests
bun test --coverage          # with coverage report
```

### Website

```bash
cd www.wdoc.info
npm install
npm run dev
npm run build
```

## CI conventions

- Root workflows live in `.github/workflows/`.
- Always use path filters so workflows trigger only for relevant subrepo changes.
- If a subrepo gains new CI requirements, add/modify a dedicated root workflow rather than adding nested workflows.

## Test coverage requirements

### Frontend
- **Statements**: 80% minimum
- **Functions**: 80% minimum
- **Lines**: 80% minimum
- **Branches**: 60% minimum
- Rule: aim for at least 1% above thresholds to ensure CI stability.

### Backend
- No formal coverage threshold yet. Single test file covers auth flow.

## Architecture decisions to respect

1. **Standalone Angular** — no NgModule anywhere, all components are `standalone: true`.
2. **OnPush change detection** — prefer this for all new components.
3. **Shadow DOM isolation** — viewer renders .wdoc HTML inside Shadow DOM.
4. **DOMPurify sanitization** — all user/document HTML is sanitized. Custom `wdoc-*` elements are allow-listed.
5. **Backend DI via factory** — `createApp()` receives all dependencies, enabling testability.
6. **Passwordless auth only** — no passwords, OTP email + JWT.
7. **No shared types package** — frontend and backend define types independently.
8. **SQLite for dev** — production may need PostgreSQL for concurrency.

## Working rules for agents

- Do not rewrite fixtures in `examples.wdoc.info/` unless explicitly asked.
- Prefer minimal, scoped edits within one subrepo.
- For cross-repo changes, document assumptions in the root `README.md`.
- Always run tests after code changes: `npm test` (frontend) or `bun test` (backend).
- When modifying pagination logic (`splitHtmlToPages.ts`), test extensively — reflow bugs cause infinite loops.
- JSZip operations are async — always `await` them.
- Do not remove `wdoc-*` custom elements from DOMPurify allow-lists.
- Production config uses file replacement in `angular.json` — edit `app.config.production.ts` for prod values.
- Check `CLAUDE.md` at root for additional deep context (data flows, env vars, pitfalls).
