# wdoc Monorepo

wdoc is an attempt to replace PDF with a zipped HTML document format that is easier for humans and LLMs to read, inspect, and process.

## Repo map

### `app.wdoc.info`

Angular 20 web app that opens `.wdoc`/`.zip` archives, renders paginated HTML, supports local form filling, and can re-export modified archives.

### `backend.wdoc.info`

Bun + Hono backend API for passwordless auth (OTP by email), JWT issuance, rate limiting, and SQLite persistence.

### `www.wdoc.info`

Astro marketing/documentation site for the wdoc project (landing pages + blog), deployed to GitHub Pages.

### `examples.wdoc.info`

Fixtures and examples for the format:
- `.wdoc` files for unit/security scenarios
- unpacked HTML samples used for debugging and test cases

## Quick start

### 1) Frontend app (`app.wdoc.info`)

```bash
cd app.wdoc.info
npm install
npm start
```

Runs on [http://localhost:4200](http://localhost:4200).

### 2) Backend API (`backend.wdoc.info`)

```bash
cd backend.wdoc.info
bun install
bun run dev
```

Runs on [http://localhost:3000](http://localhost:3000).

### 3) Website (`www.wdoc.info`)

```bash
cd www.wdoc.info
npm install
npm run dev
```

Runs on [http://localhost:4321](http://localhost:4321).

### 4) Examples (`examples.wdoc.info`)

No runtime. Use these files as sample inputs for the viewer app:
- `examples.wdoc.info/unit_test/*.wdoc`
- `examples.wdoc.info/security/*.wdoc`
- `examples.wdoc.info/unpacked/**`

## CI in monorepo mode

GitHub Actions are centralized in root `.github/workflows/` and path-scoped:
- app workflows trigger only when `app.wdoc.info/**` changes
- backend workflow triggers only when `backend.wdoc.info/**` changes
- website workflow triggers only when `www.wdoc.info/**` changes

This avoids running unrelated pipelines when only one subrepo is modified.

## Run app + backend together

From the monorepo root:

```bash
./scripts/dev-app-backend.sh
```

This starts:
- frontend on `http://localhost:4200`
- backend on `http://localhost:3000`

Use `Ctrl+C` to stop both.
