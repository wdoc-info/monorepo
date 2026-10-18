# CLAUDE.md — Context for Claude Code and coding agents

This file provides project context for coding agents. The root [AGENTS.md](AGENTS.md)
contains the repository rules. All repository-authored content must be in English,
regardless of prompt language. Every format change must update [spec/](spec/README.md)
and its affected schemas, vectors, and format rules in the same change.

wdoc is in alpha ideation, with current format version `0.1`. No design decision
is frozen. Evaluate ideas on their merits and evolve the specification with accepted
changes; do not reject a proposal solely because the current specification does not
support it. Runtime checks still enforce the current agreed format.

## Project identity

**wdoc** is an open document format built around native HTML/CSS in a ZIP archive,
with optional SHA-256 integrity/signature metadata and embedded resources. A ZIP with only `index.html` is valid and unsigned. Readers accept a root index or one enclosing folder with its immediate index; all paths are resolved at that logical root. The application supports
editing, pagination, local form persistence, and private commitment-based signatures.
The format specification describes actual byte boundaries and guarantees; do not
infer them from the rendered document alone.

## Monorepo structure

```text
wdoc-monorepo/
├── app.wdoc.info/        # Angular 20 viewer/editor
├── backend.wdoc.info/    # Bun + Hono authentication and commitment attestation API
├── www.wdoc.info/        # Astro marketing site and blog
├── examples.wdoc.info/   # Existing document fixtures and debugging samples
├── validator.wdoc.info/  # Standalone Angular local conformance/signature validator
├── spec/                # Normative format, protocol, schemas, and test vectors
├── docs/                # Operational documentation
└── .github/workflows/    # Workflows scoped by subproject paths
```

## Essential commands

### Frontend

```sh
cd app.wdoc.info
npm ci
npm start                    # Development server on port 4200
npm test                     # Karma/Jasmine tests
npm test -- --watch=false --browsers=ChromeHeadlessNoSandbox --code-coverage
npm run build -- --configuration=production
npm run e2e                  # Playwright
```

### Backend

```sh
cd backend.wdoc.info
bun install
bun run dev                  # Development server on port 3000, watch mode
bun test
bun test --coverage
bun run typecheck
```

### Website

```sh
cd www.wdoc.info
npm ci
npm run dev                  # Development server on port 4321
npm run build
```

### Standalone validator

```sh
cd validator.wdoc.info
npm ci
npm start                    # Port 4300
npm test
npm run typecheck
npm run build
npm run e2e
npm run format:sync          # Sync checked core/schema/spec mirrors
```

The validator uses a worker, never renders archive HTML, and never uploads document
data. Public-key retrieval is the only online request. It also supports a separately
selected local trusted registry. See its README before changing report/trust behavior.

### Specification validation

After installing the existing app and backend dependencies, run from the root:

```sh
bun spec/vectors/verify.ts
```

## Architecture

### Frontend — Angular 20

- Components are standalone; prefer `OnPush` change detection.
- State uses RxJS and local service state; there is no shared external store.
- The TipTap editor uses extensions for rich text, color, highlighting, and images.
- The viewer isolates document HTML in Shadow DOM. DOMPurify sanitizes it before rendering.
- JSZip writes and reads archives through application helpers, including `StreamedZip`.
- Supported custom elements are `wdoc-page`, `wdoc-container`, `wdoc-content`, `wdoc-header`, `wdoc-footer`, `wdoc-pagenum`, `wdoc-nbpages`, `wdoc-date`, and `wdoc-barcode`.
- The current layout engine is under `src/app/layout/`; historical pagination helpers also exist under `src/app/pagination/`.
- Unit tests use Karma/Jasmine; browser workflows use Playwright.
- Coverage thresholds are 80% for statements/functions/lines and 60% for branches. Aim at least one percentage point above each threshold.
- Angular Service Worker supports the PWA.

### Backend — Bun + Hono

- SQLite stores users and login codes, plus commitment receipts and a technical hash journal.
- Authentication is passwordless email OTP followed by an HS256 JWT using `jose`.
- Document/form/seal attestations use separate ES256 signing keys and a controlled public registry.
- Zod validates request bodies. Signature routes accept commitments and existing public proofs only.
- Email uses a provider abstraction: console for development or AWS SES.
- Rate limiting is in memory; multi-instance deployment needs an explicit coordination decision.
- `createApp()` receives dependencies for testability.
- Core authentication routes are `POST /login` and `POST /loginvalidate`.
- Signature routes are specified in [WDOC-ATTESTATION](spec/attestation-protocol.md).
- There are no document upload, server document-storage, access-grant, or retrieval routes in the current profile.

### Deployment

- Frontend and marketing site use GitHub Pages with their configured CNAMEs.
- Backend deployment is manual; there is no automatic backend deployment workflow.
- Root GitHub Actions workflows use path filters for the relevant subprojects.
- Signature key provisioning, DNS, TLS, and infrastructure logging controls are deployment responsibilities.

## Backend environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `./data/dev.db` | SQLite path |
| `CORS_ORIGINS` | Development/application origins from configuration | Allowed request origins |
| `JWT_SECRET` | `dev-jwt-secret` | Authentication secret; development default is prohibited when a signing private key is configured |
| `JWT_EXPIRES_IN_SECONDS` | `604800` | Authentication token lifetime |
| `OTP_EXPIRES_IN_MINUTES` | `10` | OTP lifetime |
| `EMAIL_PROVIDER` | `console` | Console or SES provider |
| `RATE_LIMIT_MAX` | `5` | Login requests per configured window |

Signature configuration uses `SIGNING_KID`, `SIGNING_PRIVATE_JWK`,
`SIGNING_PUBLIC_KEYS`, and `SIGNING_KEY_ORIGINS`. See the
[operational guide](docs/signatures/README.md) for provisioning and offline verification.
Never put private keys or bearer tokens in the repository or logs.

## Critical data flows

### Loading

```text
Local file or requested URL
  -> WdocLoaderService / ZIP safety checks
  -> Manifest integrity checks
  -> HtmlProcessingService / DOMPurify / local resources / barcodes
  -> Local pagination / templates / dynamic page metadata
  -> FormManagerService draft restoration
  -> Shadow DOM viewer with zoom
```

Signature identity/trust results are reported separately from the original-content
integrity gate. Matching hashes alone never authenticate an account.

### Export

```text
TipTap editor and local assets
  -> DocumentCreatorService
  -> index.html / original file hashes / manifest.json
  -> Local ZIP assembly
  -> Downloaded .wdoc
```

### Private signing

```text
Local document / frozen answers / attachments
  -> Local hashes and randomized commitment, with nonce retained locally
  -> Authenticated POST containing allowed commitment fields only
  -> ES256 receipt verification
  -> Atomic local insertion of JWS, nonce, and snapshot/revision/seal files
  -> Local export and user-controlled file exchange
```

The backend cannot validate the plaintext it never receives. It retains receipts
and technical journal metadata, not recoverable documents. Cloud storage is deferred.

### Authentication

```text
Email -> POST /login -> OTP email
OTP -> POST /loginvalidate -> JWT
JWT -> localStorage session (wdoc-auth-session)
```

## Common pitfalls

1. Pagination involves DOM measurement and reflow. Changes must avoid infinite loops and excessive synchronous layout reads.
2. JSZip operations are asynchronous. Always await them.
3. Document styles must stay isolated from application UI; inspect the built-in `wdoc-styles.css` and Shadow DOM behavior when changing layout.
4. Do not remove supported `wdoc-*` elements from DOMPurify allow-lists.
5. Production configuration replaces `app.config.ts` with `app.config.production.ts` through `angular.json`.
6. Frontend/backend types are defined independently; there is no shared types package. Signature verification sources are mirrored and parity-checked.
7. SQLite concurrency and in-memory rate limiting require review before a multi-instance production deployment.
8. Preserve actual manifest bytes during seal verification. Reformatting JSON can preserve an original signature while breaking a seal.
9. Draft answers are not signed snapshots. Do not present one as the other.
10. Keep document contents, names, IDs, inventories, answers, attachments, and local nonces outside the attestation request boundary.

## Coding and validation conventions

- Use strict TypeScript and the existing `*.component.ts`, `*.service.ts`, and `*.spec.ts` naming patterns.
- Keep application tests beside their source where appropriate.
- Use standalone components, not NgModules.
- Application services generally use `@Injectable({ providedIn: 'root' })`; backend dependencies enter through `createApp()`.
- Do not assume an ESLint/Prettier setup exists; inspect current tooling before invoking one.
- Run the relevant app/backend tests after code changes. Coverage numbers in prose become stale; use current command output instead of treating a historical snapshot as the current test state.
- Keep existing fixtures unchanged unless the user explicitly requests a fixture change.
