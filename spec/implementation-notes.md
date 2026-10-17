# Reference implementation

This document maps the current alpha specification to the implementation. The normative requirements remain in [WDOC-FORMAT](wdoc-format.md) and [WDOC-ATTESTATION](attestation-protocol.md).

## Source map

Paths below are relative to the repository root.

| Subject | Implementation |
| --- | --- |
| Structural validation, dates, canonical digests, IDs, paths, payload shapes, registry records | `app.wdoc.info/src/app/signatures/validation.ts`; byte-identical backend mirror |
| JSON/JCS, hashes, UTF-8/base64url decoding, commitments, cross-references, JOSE, reports | `app.wdoc.info/src/app/signatures/core.ts`; byte-identical backend mirror |
| Central/local ZIP headers, bounded expansion, CRC, validated file map | `app.wdoc.info/src/app/signatures/archive.ts`; byte-identical backend mirror |
| Local read/export, retries, registry loading, personal-provider boundary, HTML answer capture | `app.wdoc.info/src/app/signatures/signature.service.ts` |
| Immutable snapshots, revisions, local preparation and receipt insertion | `app.wdoc.info/src/app/signatures/local-document.ts` |
| Editor manifest, original inventories, and draft inventories | `app.wdoc.info/src/app/services/manifest-builder.ts` |
| Editor HTML and asset export | `app.wdoc.info/src/app/services/document-creator.service.ts` |
| Optional-manifest display validation and logical-root entry access | `app.wdoc.info/src/app/services/wdoc-loader.service.ts` |
| Access to validated cached ZIP entries | `app.wdoc.info/src/app/services/zip-reader.ts` |
| Sanitization, local CSS resources/imports, templates, dates, barcodes | `app.wdoc.info/src/app/services/html-processing.service.ts` |
| Draft save/restore, form numbering, attachment-name checks | `app.wdoc.info/src/app/services/form-manager.service.ts` |
| Layout defaults and built-in styles | `app.wdoc.info/src/app/layout/layout.constants.ts`; `app.wdoc.info/src/assets/wdoc-styles.css` |
| HTTP parsing, account authorization, receipts, journal | `backend.wdoc.info/src/signatures/routes.ts` |
| Operator registry validation and platform issuance | `backend.wdoc.info/src/signatures/services.ts` |
| Offline verification and key provisioning | `backend.wdoc.info/src/signatures/verify.ts`; `backend.wdoc.info/src/signatures/keygen.ts` |
| Standalone web validator and separate format/trust/advice report | `validator.wdoc.info/src/app/validation/validate-document.ts` |
| Validator public-key retrieval and offline trust boundary | `validator.wdoc.info/src/app/validation/verification-keys.ts` |
| Worker and document-selection isolation | `validator.wdoc.info/src/app/validation/validation.worker.ts`; `app.component.ts` |
| Validator checked mirrors | `validator.wdoc.info/scripts/sync-format.mjs`; `src/app/format/` |
| Browser origin policy | `app.wdoc.info/src/app/config/app.config.ts`; `app.config.production.ts` |

## Enforced reader boundaries

The application uses explicit validators rather than compiling JSON Schema in the browser. Those validators enforce the schemas' member/type rules and add semantic checks that schemas cannot express. The conformance runner validates positive values with Ajv, verifies cryptography independently, and exercises malformed inputs against the actual readers. The three verification modules are mirrored in the application, backend, and standalone validator. Byte parity is checked in the backend tests, validator sync check, and conformance workflow. The validator also checks byte parity of all normative schema copies and the published format/protocol copies.

| Boundary | Enforced behavior |
| --- | --- |
| Manifest | Required objects/arrays, closed top-level/signature/wrapper/submission/revision objects, known optional field types, safe IDs, valid dates, complete original inventory shape, draft inventory structure |
| Optional manifest | An absent manifest is a valid unsigned document. A present manifest requires the complete `1.0` structure; no replacement or migration is inferred. |
| Logical root | Root `index.html` is authoritative; otherwise exactly one enclosing folder contains its immediate `index.html`. All readers strip this single transport prefix before interpreting any document path. Multiple root folders, sibling files, and deeper/case-insensitive entry-point searches are rejected. |
| JSON/text | Fatal UTF-8 without a text BOM; duplicate decoded member names rejected in manifests, protected headers, payloads, registries, and requests; finite JSON values and at most 64 nested objects/arrays |
| Dates | Calendar-valid RFC 3339 date-times with mandatory zone, bounded clock/offset fields, and no leap-second spelling; writers retain UTC millisecond ISO strings |
| Base64url | Canonical hash/nonce spellings, zero unused bits, exact segment re-encoding, and no whitespace or trailing newline |
| JOSE | Exact closed `alg`/`typ`/`kid` header; duplicate-header rejection before key selection; one strict commitment-only payload shape; separate authority/identity/binding checks |
| Registry | Exact field types, unique KIDs, valid public EC P-256 material, approved origins, usage, validity intervals, and personal user binding; invalid online policy yields unavailable keys rather than stale trust |
| Revision graph | Stable document ID, complete original-name map, digest-derived archived paths, distinct current/historical scope digests; no duplicate local signature IDs across kinds/history/seals |
| Raw manifest | If actual bytes are supplied, their parsed JSON must equal the manifest being verified. Seals always use the actual supplied bytes. |
| ZIP | Original central/local names, UTF-8 extras/CRC, supported methods/flags, descriptor consistency, no collisions/overlap/unindexed content, and count/size bounds before decompression |
| Expanded data | Bounded chunk consumption, actual total/file sizes including the manifest, and actual CRC before downstream access; all readers use the same decoder and retain only checked expanded data |
| Draft forms | Global form-position fallback, exact-ID-first restoration, exact control-name matching, duplicate-free JSON, safe attachment paths, and output-name collision rejection |
| Rendering resources | Local images/fonts/imports resolve at their containing archive path; CSS layer/supports/media conditions are preserved; cycles and expansion limits are explicit; generated URLs are scoped to one processing operation |
| Receipt application | Exact receipt members, UUID shape for platform receipts, safe unique local IDs, authenticated signer and prepared commitment checks before atomic insertion |

## Intentional scope boundaries

These are format guarantees and limitations, not parser exceptions:

- A matching content inventory alone is unauthenticated integrity. Key availability, key authorization, identity trust, file integrity, original/snapshot binding, and seal completeness remain separate results.
- `runtime` is outside the original digest. In particular, a form signature does not authenticate descriptor `createdAt` or `replaces`; a seal covers their actual manifest bytes. No correction graph or chronology is inferred from them.
- A form signature covers exactly its descriptor's answer/attachment set. The lower-level signing interface accepts JSON answers beyond the standard DOM collection schema. File verification does not invent an application-specific form validation or attachment-safety guarantee.
- Historical scopes are structurally unique and share the document ID, but there is no signed parent pointer, global revision counter, or certified chronological order.
- The static resource recognizer is deliberately restricted as specified. DOMPurify and Shadow DOM remain necessary, and identical signed bytes do not guarantee identical browser font metrics or pixels. External images retain their explicit consent flow for unsigned display; CSS resource resolution does not introduce remote fetches.
- Earlier seals become obsolete after later additions. Removing the newest pair or rolling back an entire archive requires an independently retained reference to detect reliably. An absent seal yields no completeness claim.
- Personal provider enrollment, trusted timestamps, stronger transaction authentication, and cloud storage are outside the implemented profile.

## Current profile

The manifest version is `1.0`, with ES256/SHA-256 and the three `v1` commitment domains. The format has no unversioned hash-manifest profile, inventory-bearing signature payload, locale-dependent auxiliary digest, or migration path. The editor writes `createdAt`/`contentUpdatedAt` and canonical base64url file hashes; draft inventory sections use `{hashAlgorithm:"SHA-256",files}`.

Manifestless viewing preserves the supplied archive. A local signing client can create an unauthenticated candidate manifest for review, then persist it during explicit signing/export. All document bytes and local nonces stay on the client. Exports use logical-root paths; rewrapping under one enclosing folder preserves signatures and seals, including their actual manifest bytes.

The offline verifier accepts both root layouts. For manifestless input it reports a null digest and unsigned content/document checks. Its exit code is zero for a valid unsigned archive or for successful trusted checks, and nonzero for invalid structure, modified content, unavailable/untrusted/unauthorized keys, or invalid signatures/bindings. An obsolete older seal is allowed when another seal validates the supplied snapshot. Exit code zero alone does not establish identity or completeness; inspect the separate checks.

## Standalone browser validator

`validator.wdoc.info` implements the verifier role without rendering or executing
archive HTML. ZIP/layout parsing, schema/semantic validation, hashing, and signature
verification run in a worker. Format conformance, per-scope cryptographic/trust
results, and optional recommendations remain separate. A manifestless document
keeps a null document digest; recommendations for a manifest, signatures, HTML
metadata, stable form IDs, and a final seal do not invalidate it.

A missing/untrusted key produces incomplete verification. The interface does not
promote dependent form/seal bindings to success when their original proof is
unresolved, and it hides residual signer labels on failed checks. A superseded
older seal is identified when another trusted seal validates the supplied snapshot.

Schema and JWS byte-shape checks still run when public keys are unavailable. The
validator additionally reports declared files that are absent, unsigned revision
inventories, answer JSON, attachment restrictions, and text encoding. It does not
invent an application-specific answer schema, infer a signed correction chain,
render pages, measure pagination, scan binary attachments, or establish external
rollback protection. Optional draft inventory mismatches are advisory because
those inventories are outside the original scope. Producer-only canonical JSON
recommendations do not replace the reader's exact-byte JWS verification.

The only network boundary is a credential-free GET of the independently configured
public key registry, with no document data or dynamic KID resolution. An explicitly
selected local registry supplies independent offline trust policy. The web tool
bounds registry responses to 1 MB and online waits to ten seconds; exceeding these
UI resource bounds means unavailable trust data, not an invalid wdoc format.
No format version, signature algorithm, commitment value, or domain changes.

## Validation entry points

- [Vector catalog and validator](vectors/README.md): schema checks, independent ES256 verification, archive mutations, JSON/path/ZIP/key rejection cases, and source parity.
- Validator tests and workflow: `cd validator.wdoc.info && npm test && npm run typecheck && npm run build && npm run e2e`; root `.github/workflows/validator-tests.yml`.
- Backend tests: `cd backend.wdoc.info && bun test`.
- Frontend tests: `cd app.wdoc.info && npm test -- --watch=false --browsers=ChromeHeadlessNoSandbox --code-coverage`.
- Browser workflow: `cd app.wdoc.info && npm run e2e -- e2e/wdoc.signatures.spec.ts`.
- CI: root `.github/workflows/spec-tests.yml`, with path filters for the spec and relevant implementation/dependency changes.

These checks establish the covered behaviors; they are not an independent security audit or proof of exhaustive browser behavior coverage.
