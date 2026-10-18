# wdoc conformance vectors

The vectors accompany the current alpha specification. They are published test data, not documents for real signing. Test keys, account labels, dates, and nonces MUST NOT be used as production credentials or production randomness. The key material is intentionally recognizable test material; there are no production private keys in this directory.

All manifest and historical scope versions use the current alpha version `0.1`.
The version is part of the protected scope, so its designation is reflected in
document digests, revision paths, commitments, JWS values, and raw-manifest seal
inventories throughout these vectors. Original HTML/CSS/answer/attachment bytes,
test public keys, nonces, SHA-256/ES256 algorithms, and `v1` commitment domains are
unchanged.

| File | Contents |
| --- | --- |
| [registry.json](registry.json) | Two public EC P-256 records and allowed origins: platform attestation and enrolled personal form signing |
| [intermediates.json](intermediates.json) | SHA-256 primitives, JCS strings, complete protected scope, three nonce/value/preimage/commitment calculations, decoded platform payloads |
| [positive.json](positive.json) | Nine complete logical archive file maps and expected reports |
| [mutations.json](mutations.json) | 54 archive/key-policy mutations, seven JSON parser cases, 20 path cases, 16 ZIP cases, and nine registry cases |
| [layouts.json](layouts.json) | 17 root/wrapped/minimal unsigned layout acceptance and rejection cases |
| [fonts.json](fonts.json) | 12 external-font declaration, URL, resource-context, and embedded-copy integrity cases; no network requests |
| [requests.json](requests.json) | Three valid endpoint bodies and five structurally rejected bodies |
| [verify.ts](verify.ts) | Executable local validator using the existing repository dependencies |

## Encoding and comparison

Every `positive.json` case's `files` object maps exact safe archive paths to **standard padded base64** of actual uncompressed bytes. This is a vector transport encoding; archive files themselves are not base64 text. Decode each value once before hashing, rendering, packing, or verification. `manifest.json` is included in this map so its exact seal-protected bytes are available. There is no implicit newline or whitespace to append.

`canonical`, `canonicalPreimage`, and `utf8` strings in the intermediate file are literal strings after JSON escape decoding. Hash their UTF-8 encoding without a BOM or added newline. `value` is a JSON value, not a second JSON string serialization. The example document digest is `dd15tS2aA-gLgKbDwvvlymewCS_LECdxSlHMfsyblBs`.

Inventory assertions compare all own path/hash members independently of JavaScript object prototypes and member order. The runtime's null-prototype dictionaries and the ordinary objects parsed from the vectors represent the same JSON inventory. Regression checks require changed hashes, missing paths, and additional paths to fail comparison. Archive byte comparisons remain strict and preserve every byte.

The positive cases are:

1. `unsigned`: inventory matches, document is unsigned.
2. `document-signed`: trusted original commitment.
3. `form-signed`: immutable platform-attested submission.
4. `sealed`: complete current sealed snapshot.
5. `two-seals`: first seal is `archive-changed`; the later seal is current.
6. `personal-cosigned`: platform and enrolled personal form signatures on the same bytes.
7. `revised`: current original is new; the old form binds to a verified historical original.
8. `unicode-revision`: a signed historical scope preserves a valid Unicode line-separator path exactly.
9. `editable-draft`: unsigned manifest and draft inventory use the same SHA-256/base64url encoding.

`expected` contains `documentDigest`, `content` status, and arrays of document/form/revision/seal statuses in file/wrapper iteration order. For mutation cases, only members present in `expected` are asserted; other checks may also fail. `{error:true}` means the core verifier rejects the malformed structure instead of returning a report.

## Mutation operations

Each mutation starts from a fresh copy of the named positive `base`. Operations run in order:

| Operation | Effect |
| --- | --- |
| `file-set` | Replace/create `path` with `UTF8(text)`, or with decoded standard base64 bytes when `base64` is supplied instead |
| `file-delete` | Remove `path` |
| `manifest-set` | Set `value` at a JSON Pointer into the parsed manifest |
| `manifest-delete` | Remove a member at a JSON Pointer into the parsed manifest |
| `manifest-format` | Serialize the same manifest as two-space JSON with a final LF |
| `registry-set` | Set `value` at a JSON Pointer into a fresh copy of `registry.json` |

Manifest set/delete operations serialize the changed manifest with JCS after all operations. The byte-only formatting operation preserves the parsed value. File-only and registry-only cases preserve the original manifest bytes. JSON Pointers use `/` segments and the standard `~0`/`~1` escaping; this catalog does not use append pointers or array removal.

Some cases deliberately preserve one layer while invalidating another: draft additions keep document/form signatures valid; manifest whitespace invalidates only a seal; changing `createdAt`/`replaces` does not break a form commitment; discarding the newest seal pair can restore an older valid snapshot. These outcomes are part of the format's stated limits, not expected rejection gaps.

Layout cases explicitly accept an index-only ZIP without any manifest or signature material, with or without one enclosing folder. They reject multiple root folders, empty sibling folders, sibling files, metadata folders beside a wrapper, extra wrapper depth, and case-folded index names. A root index allows any number of safe resource folders. Every positive manifest/signature/seal case is also repacked under a single enclosing folder and verified against identical logical paths and bytes.

ZIP safety cases create small archives and apply the named header/data mutation before running the complete bounded reader. Preflight rejects declared oversize inputs without decompression. A dishonest smaller declared size and a bad data CRC are tested during decoding; streamed descriptors have a positive case. Registry cases test structure, origins, usage, uniqueness, dates, and curve-point validity. JSON/path cases exercise the exact parser and path predicate independently of schemas.

## Run the validator

Install the existing backend and app dependencies using their normal commands, then run from the repository root:

```sh
bun spec/vectors/verify.ts
```

The script uses Bun and backend dependencies for the verification core, `jose`, and JSZip. It resolves Ajv and `ajv-formats` from the app's existing Angular toolchain; no new runtime dependency or external service is required. It compiles schemas offline, validates positive manifests and decoded JOSE values, independently verifies every positive ES256 signature with Node's crypto API, recalculates hashes/preimages, runs mutations, safety cases, and public-registry cases, and round-trips positive archives through both STORED and DEFLATE ZIPs, with and without a folder wrapper. It systematically substitutes field values in manifests, registries and payloads to ensure the runtime does not accept schema-invalid structures; semantic constraints may make the runtime stricter. It also checks parity of the core, validation, and archive modules across the frontend/backend/web validator, as well as the validator schema and published specification copies and Markdown links within `spec/`.

To obtain a real ZIP from a vector file map, decode each value and write it under its object key using a ZIP library. Compression and entry timestamps may vary; the cryptographic file bytes and names may not. The repository's offline CLI can then verify it with this test registry. Do not add the test registry to a production trust store.

ECDSA issuance is not assumed deterministic. The published JWS values are fixed verification inputs; a newly issued signature for the same payload need not have identical signature bytes. New vector generation must preserve or explicitly revise downstream raw-manifest/seal preimages. Do not regenerate JWS values as an incidental formatting change.

`history.json` exercises independent Git/document transport budgets and wrapper
classification. Git runtime mutations in `mutations.json` demonstrate that original
and form proofs survive history changes while whole-archive seals become obsolete.
