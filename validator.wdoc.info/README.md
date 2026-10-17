# wdoc Validator

A standalone Angular 20 application for `validator.wdoc.info`. Drop a `.wdoc` or ZIP
file to inspect it against the current [WDOC-FORMAT specification](../spec/README.md).
The interface and repository-authored content are in English.

The document stays in browser memory. Parsing, hashes, and signature verification run
in a web worker. Document HTML is never inserted into the page, rendered, or executed.
There is no upload endpoint, document storage, account, analytics, external font, or
remote document preview. A JSON report can be downloaded locally.

## Run

Use a Node version supported by Angular 20 (`20.19+` in Node 20, `22.12+` in Node 22,
or Node 24+) and Bun for the unit tests.

```sh
npm ci
npm start
```

Open [http://localhost:4300](http://localhost:4300).

```sh
npm test                 # Report, key-policy, and normative archive/mutation tests
npm run typecheck        # Angular templates, TypeScript, and the worker
npm run build            # Static output: dist/validator/browser
npm run e2e              # Chromium browser workflows
```

For a standalone browser-test installation, run `npx playwright install chromium`.
Local tests can also reuse the monorepo viewer's Puppeteer Chromium when installed.
`CHROME_BIN` selects an explicit executable. CI installs its own Chromium.
The unit-test coverage threshold is 81%; browser tests exercise the Angular interface,
file selection/drop, report download, online/offline trust, cancellation, and mobile layout.

## Read the report

Three independent sections prevent optional features from becoming format errors:

- **Format checks:** original ZIP metadata, paths, duplicate/colliding entries, bounds,
  actual sizes/CRC, deterministic logical root, UTF-8 entry point/text, a present
  manifest's schema and semantic constraints, exact original membership/hashes,
  static dependencies, revisions, declared submission files, and JWS byte shapes.
- **Signature verification:** exact ES256 verification, original/form/revision bindings,
  local commitment nonces, whole-archive seals, and external key/identity policy.
  Missing/untrusted keys yield incomplete verification. Invalid cryptography or
  bindings fail. A superseded seal is identified when a different trusted seal
  validates the supplied snapshot. Failed checks do not retain a trusted-looking
  signer label. Per-scope results remain separate from archive format conformance.
- **Optional improvements:** missing manifest/original signature/final seal, useful
  HTML metadata, stable form IDs, unsupported custom elements, ignored draft JSON,
  stale descriptive draft inventories, unsigned submissions, and retention advice.
  These suggestions never make an otherwise conforming unsigned document invalid.

A ZIP with only `index.html` is valid and unsigned, with no invented document digest.
A single enclosing folder containing its immediate `index.html` is also valid. Without
a root index, multiple root folders (including empty or OS-metadata folders), sibling
root files, deeper wrappers, or a case-insensitive index spelling are invalid. With a
root index, ordinary resource/runtime subdirectories are allowed.

The tool checks source data and the implemented static signing profile. It does not
render/paginate pages, certify legal identity or time, scan binary attachments,
validate an application-specific answer vocabulary, or establish an external latest
archive reference. A successful original signature does not authenticate editable
answers or every form submission. A final seal covers the supplied snapshot.

## Public keys and offline use

The default online policy is in [`src/app/config.ts`](src/app/config.ts):

- Public registry URL: `https://backend.wdoc.info/signing-keys`.
- Allowed signing-key origins: `https://sig.wdoc.info`.

When usable signature material is present, the only network operation is an anonymous,
credential-free GET to that fixed registry URL. No file bytes, names, hashes, document
IDs, answers, attachments, nonces, or bearer tokens enter the request. Redirects are
rejected. The response cannot broaden the build-time origin allow-list. Unknown KIDs
never cause arbitrary URL fetches. Each run clears online trust rather than retaining
keys from an earlier successful response after a failure.

For offline verification, select **Local registry** and load an independently trusted
JSON file containing exactly `{ "keys": [...], "allowedOrigins": [...] }`, following
[the registry schema](../spec/schemas/key-registry.schema.json). This is public key
policy, not a signing secret. Private JWK `d` material, malformed/duplicate records,
invalid curve points, or invalid origin policy are rejected. Importing a registry is
an explicit choice of trust source; a registry bundled inside a document is never used.
Invalid local registry input clears previous usable local keys and rechecks the report.

The web tool limits key registries to 1 MB and public-key retrieval to ten seconds.
These are UI resource limits, not changes to the wdoc container specification.
An unavailable or rejected registry does not prove a signature is mathematically invalid.

To change the online authority, update the fixed configuration and the `connect-src`
policy in [`src/index.html`](src/index.html), then rebuild. Deployments overriding the
API's `CORS_ORIGINS` must include `https://validator.wdoc.info`; the backend defaults
already include that domain and local port 4300. For a third-party personal key provider,
its exact HTTPS origin must be configured independently, not supplied by the archive.

After the application has loaded, local-registry validation needs no network. No
service worker, localStorage, IndexedDB, document persistence, or cloud recovery is added.

## Specification synchronization

[`spec/`](../spec/README.md) and the existing verifier are authoritative. This project
uses checked-in byte-identical mirrors of `core.ts`, `validation.ts`, `archive.ts`,
all normative JSON schemas, and the two published Markdown specifications. This
keeps the application independently buildable without a shared types package.

```sh
npm run format:sync
```

Run this after every relevant format change, then update the report tests in the same
change. Do not edit the generated mirrors directly. `npm test` and the root spec
conformance runner reject drift. Unit tests execute the normative positive archives,
root layouts, and malformed archive/key-policy mutations against the report engine.

## Static hosting

Build with `npm run build` and serve **`dist/validator/browser`** over HTTPS. The build
includes `CNAME`, favicon, application assets, worker, and raw specifications under
`/spec/`. No server-side document handling is needed. The application is at the domain
root; it does not require client-side routing or a route fallback.

The root [`validator-tests.yml`](../.github/workflows/validator-tests.yml) checks
mirrors, tests, types, production output, and browser workflows on relevant changes.
It does not publish the site or modify DNS. The build artifact can be deployed to
`validator.wdoc.info` using the repository's chosen static hosting setup.
