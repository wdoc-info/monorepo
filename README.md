# wdoc Monorepo

wdoc is an attempt to replace PDF with a zipped HTML document format that is easier for humans and LLMs to read, inspect, and process.

## Repo map

### `app.wdoc.info`

Angular 20 web app that opens `.wdoc`/`.zip` archives, renders paginated HTML, supports local form filling, and can re-export modified archives.

### `backend.wdoc.info`

Bun + Hono backend API for passwordless auth (OTP by email), JWT issuance, rate limiting, and SQLite persistence.

### `www.wdoc.info`

Astro marketing/documentation site for the wdoc project (landing pages + blog), deployed to GitHub Pages.

### `validator.wdoc.info`

Standalone Angular web app for private drag-and-drop validation against the current
specification. It checks ZIP/layout safety, manifests and inventories, signatures,
submissions, revisions, and seals, and reports optional improvements separately.
Documents are inspected locally in a worker and never uploaded or rendered.

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

### 5) Validator (`validator.wdoc.info`)

```bash
cd validator.wdoc.info
npm ci
npm start
```

Runs on [http://localhost:4300](http://localhost:4300). See the
[validator guide](validator.wdoc.info/README.md) for public-key policy, offline
registries, tests, and static hosting.

## CI in monorepo mode

GitHub Actions are centralized in root `.github/workflows/` and path-scoped:
- app workflows trigger only when `app.wdoc.info/**` changes
- backend workflow triggers only when `backend.wdoc.info/**` changes
- website workflow triggers only when `www.wdoc.info/**` changes
- validator checks run for its sources, authoritative format modules, and specification changes

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

## Format specification and repository language

The normative format is defined in [`spec/README.md`](spec/README.md), including
the ZIP/HTML container, manifest, forms, revisions, signatures, commitments, seals,
JSON schemas and executable test vectors. The companion
attestation protocol specifies the boundary where documents remain local. The current alpha
format has no legacy profiles or migration paths. A ZIP containing only
`index.html` is valid and unsigned. Readers also accept exactly one enclosing
folder containing its immediate `index.html`; they reject multiple root folders
or sibling root files when no root `index.html` exists. With a root `index.html`,
multiple resource/runtime folders are valid. All readers resolve the same logical
paths, preserving file bytes and signatures when a folder wrapper changes. The
manifest is optional; if present it must fully conform to version `0.1`.

wdoc is in alpha ideation: no design decision is frozen, and the specification
evolves with accepted ideas and implementation changes. The `0.1` format version
is used consistently by the app, backend, validator, schemas, and conformance
vectors. It is independent of application/document versions and the unchanged
`v1` commitment domains. Changing the manifest version changes protected scope
digests and dependent proofs; published test vectors reflect the current version.

The browser, signing API, and offline verifier use the same mirrored structural
rules and ZIP decoder. The browser's `backend.signingKeyOrigins` is configured in
both development and production builds and must include each enrolled key
provider's approved HTTPS origin. It is independent of registry response data.
Run `bun spec/vectors/verify.ts` after installing the existing app/backend
dependencies; the dedicated format-conformance workflow also runs these vectors.
The current cryptographic profile uses SHA-256, ES256, and `v1` commitment domains.

Every format change must update the specification and relevant schemas/vectors
in the same change. All repository-authored content must
be in English, regardless of the language used in a prompt. See
[`AGENTS.md`](AGENTS.md) for the maintenance rules.

## Private digital signatures (frontend + backend)

The signature implementation is documented in [`docs/signatures/README.md`](docs/signatures/README.md),
with normative schemas in [`spec/schemas/`](spec/schemas/README.md), an offline
verifier and provisioning instructions. Documents,
original metadata, answers, attachments, file names and archive assembly stay in
the browser. The backend accepts only randomized cryptographic commitments and
existing public proofs, then returns a JOSE ES256 attestation of the authenticated
request. Its SQLite tables retain only signature receipts and a hash audit journal;
there are no document upload, storage, sharing or retrieval routes. Personal
signatures can be completed with a local signing provider. Cloud storage is deferred.
The independent frontend/backend verification cores remain mirrored and checked
for parity in CI. Public key DNS/TLS and private-key provisioning are deployment responsibilities.

## Standalone validator integration

The validator deliberately mirrors the same three verification modules and normative
JSON schemas rather than adding a shared types package. Its sync check and the
specification conformance runner reject drift. Run `npm run format:sync` in
`validator.wdoc.info` after changing authoritative format sources.

Format validity, signature verification, and optional recommendations are independent
report sections. A minimal unsigned ZIP remains valid. Missing/untrusted keys remain
unverified; failed cryptography or bindings are reported as failures. A superseded seal
is distinguished when another trusted seal covers the supplied snapshot.

The sole network operation is an anonymous, credential-free GET to the configured
public key registry, and only when verifiable signature material is present. Online
key origins come from build configuration. A separate user-selected local registry
provides offline trust policy; archive-supplied keys never establish trust. The API's
default CORS origins include the validator domain and development origins. Deployments
that override `CORS_ORIGINS` must explicitly include `https://validator.wdoc.info` to
allow public-key lookup. No document storage or cloud-sharing service is introduced.

## External document fonts

The alpha `0.1` format supports archive-local fonts and HTTPS `@font-face` sources.
The viewer and editor use frontend defaults for Google Fonts, Bunny Fonts, and
Fontsource's dedicated jsDelivr paths, with browser-local remembered permissions
and blocks managed through **Font settings**. An archive cannot grant itself trust.
Font stylesheets are reduced to font declarations before export/signing, and
`content.externalFonts` protects each remote binary's SHA-256 fingerprint.
Signing remains local apart from commitment attestation; the API receives no font
URLs or data. The validator checks this profile offline without fetching fonts.
**Include fonts for offline viewing** adds digest-addressed runtime copies while
preserving protected originals and content signatures; existing seals may need
renewal after the archive gains files. See [the font profile](spec/wdoc-format.md#56-external-fonts-and-reader-permissions).

The WYSIWYG includes a searchable, bundled Google Fonts catalog and downloads a
family only when selected. Its regular/bold and italic styles follow Google's
available variants. The example library includes
[`google_fonts.wdoc`](examples.wdoc.info/unit_test/google_fonts.wdoc) and its
[unpacked HTML source](examples.wdoc.info/unpacked/unit_test/google_fonts/index.html):
six external families in an unsigned, manifestless archive, with no font binaries.
This editor and fixture addition uses the existing `0.1` font profile unchanged.

## Local folder access

The web app detects File System Access support and adds a **Local folder** tab.
It lists `.wdoc` files from a user-selected folder and keeps files opened there
linked for direct WYSIWYG saves with **Save document** or **Ctrl/Cmd+S**. Folder
handles are remembered only in this browser's IndexedDB. Unsupported browsers
keep file-input opening and downloads. The app and operational documentation use
the existing `0.1` archive and revision profile; the API, validator, and examples
require no local-filesystem integration. See [the local-file guide](docs/local-files.md)
for permission renewal, Save as, archive preservation, and write failures.

### Embedded local version history (alpha)

The app, format specification, backend offline verifier and standalone validator
share the optional `.git/` runtime namespace and its separate archive budget.
The editor keeps local autosave branches inside each document, merges on Save,
and offers visual comparison, conflict resolution and restore-as-draft. This
feature has no server document storage or remote Git synchronization. See
[the history guide](docs/version-history.md) and [format Section 20](spec/wdoc-format.md#20-embedded-local-version-history).
