# Agent Guide: wdoc Monorepo

This repo contains four previously separate projects. Keep changes scoped to the relevant subrepo unless a cross-repo change is explicitly requested.

## Directory map

- `app.wdoc.info/`: Angular viewer/editor for `.wdoc` files (main product UI).
- `backend.wdoc.info/`: Bun/Hono auth API (OTP + JWT + SQLite).
- `www.wdoc.info/`: Astro marketing site and blog.
- `examples.wdoc.info/`: `.wdoc` fixtures and unpacked HTML test content.

## Fast orientation

### `app.wdoc.info` key files

- `app.wdoc.info/src/app/app/app.component.ts`: main orchestration (load, render, edit, export).
- `app.wdoc.info/src/app/services/wdoc-loader.service.ts`: archive loading/parsing.
- `app.wdoc.info/src/app/services/html-processing.service.ts`: sanitization + HTML processing.
- `app.wdoc.info/src/app/pagination/html-pages/`: pagination logic.
- `app.wdoc.info/src/app/services/document-creator.service.ts`: build/export `.wdoc`.

### `backend.wdoc.info` key files

- `backend.wdoc.info/src/app.ts`: Hono routes (`/login`, `/loginvalidate`).
- `backend.wdoc.info/src/db.ts`: SQLite access and schema.
- `backend.wdoc.info/src/config.ts`: environment parsing/defaults.
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
npm start
npm test
```

### Backend

```bash
cd backend.wdoc.info
bun install
bun run dev
bun test
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

## Working rules for agents

- Do not rewrite fixtures in `examples.wdoc.info/` unless explicitly asked.
- Prefer minimal, scoped edits within one subrepo.
- For cross-repo changes, document assumptions in the root `README.md`.
