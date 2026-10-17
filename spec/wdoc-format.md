# WDOC-FORMAT: wdoc document format 1.0

Status: alpha project specification. Manifest profile `1.0`; commitment domains `v1`.

## Abstract

A wdoc document is a ZIP archive containing an HTML entry point and optional local resources, integrity manifest, and signature material. The format supports editable form drafts, immutable signed answer snapshots, multiple signers, archived content revisions, and a seal of a complete logical archive snapshot. Original content and every attachment remain local during signing. A platform signs randomized commitments after authenticating an account; recipients verify the actual document and its commitments locally.

This document defines one current format, its optional integrity/signature features, and its verification semantics. It does not assign an IANA media type, claim IETF standardization, or define cloud storage.

## Contents

1. [Scope and conformance](#1-scope-and-conformance)
2. [Terminology and notation](#2-terminology-and-notation)
3. [Primitive representations](#3-primitive-representations)
4. [ZIP container and paths](#4-zip-container-and-paths)
5. [HTML document and rendering](#5-html-document-and-rendering)
6. [Manifest](#6-manifest)
7. [Original content integrity](#7-original-content-integrity)
8. [Editable form drafts](#8-editable-form-drafts)
9. [Immutable form submissions](#9-immutable-form-submissions)
10. [Content revisions](#10-content-revisions)
11. [JWS and key policy](#11-jws-and-key-policy)
12. [Randomized commitments](#12-randomized-commitments)
13. [Original document signatures](#13-original-document-signatures)
14. [Form signatures](#14-form-signatures)
15. [Archive seals](#15-archive-seals)
16. [Creation and mutation procedures](#16-creation-and-mutation-procedures)
17. [Verification procedure and results](#17-verification-procedure-and-results)
18. [Archive conformance examples](#18-archive-conformance-examples)
19. [Versioning and extensions](#19-versioning-and-extensions)
20. [Security considerations](#20-security-considerations)
21. [Privacy considerations](#21-privacy-considerations)
22. [Registrations and references](#22-registrations-and-references)
23. [Test vectors](#23-test-vectors)

## 1. Scope and conformance

### 1.1. Requirement language

Uppercase MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL express BCP 14 requirements as defined by [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174). Lowercase occurrences have their ordinary English meaning.

### 1.2. Roles and profiles

An implementation MUST identify which of these roles it supports:

| Role | Required behavior |
| --- | --- |
| Archive producer | Produce the ZIP, safe paths, and UTF-8 `index.html` in Sections 3–5. A manifest and signatures are OPTIONAL; when present they MUST conform to Sections 6–15. |
| Viewer | Inspect archive safety and original integrity before rendering; sanitize untrusted HTML; keep rendering separate from cryptographic trust. |
| Signature producer | Additionally implement Sections 9–16 and the local privacy boundary. New signatures use the commitment profile. |
| Verifier | Verify original files, individual signatures, submission bindings, historical scopes, and seals separately under an externally supplied key policy. |
| Attestation service | Implement [WDOC-ATTESTATION](attestation-protocol.md). This role receives commitments, not archives. |

Producers and readers MUST satisfy the relevant [schemas](schemas/README.md) and the semantic constraints in this document. A schema-valid object is not necessarily a valid document. Readers MUST NOT repair malformed structures, infer missing manifest versions, or silently reinterpret another profile. The reference readers enforce equivalent structural constraints through a mirrored validation module and add byte-level, cross-reference, and cryptographic checks; they do not compile JSON Schema at runtime. See [implementation notes](implementation-notes.md).

A ZIP containing only a valid UTF-8 `index.html` is a complete conforming unsigned wdoc document. It requires no manifest, document ID, hashes, nonces, keys, signature arrays, submissions, revisions, or seals. A manifestless document has no authenticated integrity claim; readers MUST accept it as unsigned. Archive validity and signature trust are separate results. Matching hashes provide integrity relative to an unauthenticated manifest, not an authenticated identity. A verifier MUST NOT describe a document as fully verified merely because one signature or one inventory matches.

### 1.3. Explicit exclusions

This version does not specify encryption at rest, a password-protected archive, JavaScript applications inside documents, remote document custody, collaborative cloud state, public document URLs, signature certificates, PKI path validation, a qualified electronic signature, a trusted timestamp, or a global append-only document history. Personal-key form signatures have a local integration boundary; key enrollment and hardware-provider integration are outside the format.

## 2. Terminology and notation

**Archive file** means an uncompressed regular ZIP entry identified by its exact logical document path after the root resolution in Section 4.4. Directory entries are container metadata, not files in a cryptographic inventory.

**Original** means every archive file outside `manifest.json` and the four runtime prefixes in Section 4.3. Original does not mean immutable forever: editing it creates a new content revision.

**Protected scope** is the object containing exactly `manifestVersion`, `meta`, and `content`, extracted from a manifest or historical scope. Every member nested within `meta` and `content` participates in its digest.

**Draft** is editable state in `wdoc-form/`. **Submission** is a frozen answer file and its explicitly enumerated attachments. **Signature wrapper** locates a JWS and its local nonce. **Seal** commits to the complete set of logical archive files except its own JWS/nonce pair.

**Trusted** refers to a verifier's configured key/identity policy, not a field supplied by the document. **Platform attestation** authenticates a request made through an account session. **Personal signature** uses a separately enrolled personal key. Neither term alone establishes a legal identity assurance level.

Notation:

```text
UTF8(s)       UTF-8 encoding of string s, without a byte order mark
B64U(b)       unpadded base64url encoding of byte sequence b
SHA256(b)     32-byte SHA-256 digest of byte sequence b
H(b)          B64U(SHA256(b))
JCS(x)        JSON Canonicalization Scheme serialization of JSON value x
Inventory(F)  object mapping each exact file path p in F to H(F[p])
Scope(M)      {manifestVersion:M.manifestVersion, meta:M.meta, content:M.content}
Digest(M)     H(UTF8(JCS(Scope(M))))
```

`F[p]` denotes actual uncompressed bytes, not base64 text, a rendered DOM, a data URL, or a filesystem representation. Pseudocode object member order is explanatory; JCS determines canonical order. JSON object member names and all protocol strings are case-sensitive.

## 3. Primitive representations

### 3.1. JSON and Unicode

Archive JSON, HTML/CSS text, protected headers, and JWS payloads MUST use UTF-8 without a BOM. Readers MUST reject invalid UTF-8 rather than replace bytes with U+FFFD. JSON values follow [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259). Object member names MUST be unique after JSON escape decoding: `"a"` and `"\u0061"` are the same name. Manifest, registry, protected-header, signed-payload, and signing-request parsing MUST reject duplicate names, non-finite numbers, and lone UTF-16 surrogates. JSON nesting MUST NOT exceed 64 open objects/arrays in the current profile, including programmatically supplied values before JCS. Strings MUST NOT be Unicode-normalized before hashing or comparison. A U+FEFF character within an archive filename is a literal path character, not a text-file BOM to discard.

JCS follows [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785). The supported data model uses finite ECMAScript binary64 numbers, ordinary JSON objects, arrays, strings, booleans, and null. Unsupported values such as `undefined`, non-JSON objects, and non-finite values MUST NOT be serialized. Implementations requiring exact large integers SHOULD encode them as strings. Negative zero and equivalent numeric spellings canonicalize according to JCS; do not invent a separate decimal serialization.

Manifest whitespace and member order MAY vary on disk. They do not affect the original digest after parsing and canonicalization. They DO affect a seal, which hashes the actual `manifest.json` file bytes. JSON inside a submission is protected as file bytes; reformatting it changes the form commitment even if its parsed value is equal.

### 3.2. Identifiers and encodings

The following ABNF uses the basic notation of [RFC 5234](https://www.rfc-editor.org/rfc/rfc5234). Literal identifiers and constants elsewhere in this document are case-sensitive.

```abnf
b64u-char  = ALPHA / DIGIT / "-" / "_"
digest     = 43b64u-char
nonce      = 43b64u-char
identifier = 1*128b64u-char
jws        = 1*b64u-char "." 1*b64u-char "." 1*b64u-char
```

`digest` is the string representation of a 32-byte hash. New nonces MUST be generated from 32 random bytes and encoded with B64U. No padding, whitespace, line wrapping, `+`, or `/` is allowed in these fields or compact JWS segments, including a final line break. Readers MUST require canonical B64U: unused final bits are zero, so a 43-character digest/nonce ends with one of `AEIMQUYcgkosw048`. Every JWS segment MUST equal B64U of its decoded bytes. Commitment construction still uses the exact nonce string as a JSON string; it does not replace that string with decoded nonce bytes.

Document, form, submission, and signature IDs in newly written archives MUST satisfy `identifier` and the path predicate in Section 4.2. The three reserved segment names in that section are prohibited even though they match the ABNF. Writers normally generate UUIDs for document, submission, and signature IDs. UUID syntax is not required for archive IDs; the protocol's `requestId` specifically requires UUID syntax.

IDs are scoped to the archive. Submission IDs MUST be unique across all forms in an archive. Newly generated signature IDs MUST be unique across current document signatures, form signatures, historical signatures, and seal pairs. A signature ID is a local locator; it is not a signed claim or a cryptographic identity.

### 3.3. Dates

Producers MUST emit date-time strings in UTC in the shape `YYYY-MM-DDTHH:mm:ss.sssZ`, as produced by ECMAScript `Date.toISOString()`, for supported ordinary four-digit years. Readers MUST require an [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) date-time with a four-digit year, a valid Gregorian calendar date, hour `00`–`23`, minute/second `00`–`59`, and a mandatory `Z` or `+/-HH:mm` offset. Lowercase `t`/`z` and optional nonempty fractional seconds are accepted. Offset hours are `00`–`23` and minutes `00`–`59`. Leap-second spelling `:60`, rollover dates, date-only strings, human-readable dates, and trailing whitespace are unsupported. Conversion to a finite instant MUST succeed after these syntax/calendar checks; `Date.parse` alone is insufficient.

`signedAt` is asserted by the signer. It MUST NOT be treated as independently certified time. `createdAt`, `contentUpdatedAt`, and `updatedAt` do not provide an ordering or anti-rollback guarantee.

### 3.4. Equality

Compare IDs, digest strings, commitment strings, paths, types, and KIDs by exact decoded string equality. Do not case-fold, trim, percent-decode, normalize Unicode, resolve symlinks, or apply a locale collation to these comparisons. JCS sorts member names by UTF-16 code units, not by locale.

## 4. ZIP container and paths

### 4.1. Container profile

The customary extension is `.wdoc`. The current viewer also accepts `.zip` through its file workflow; the extension does not prove content type. This version has no required ZIP `mimetype` entry or additional magic header. The download implementation uses `application/zip` for signed exports.

A producer MUST create an ordinary single-disk ZIP with STORED (method 0) or DEFLATE (method 8) entries. A conforming archive MUST meet all of these conditions:

1. A complete end-of-central-directory record ends at the end of the byte stream, including its declared comment. Trailing bytes are not allowed.
2. Disk numbers are zero; central-directory counts agree. The central directory ends immediately before the end record.
3. There are at most 1,000 central-directory entries, counting directories.
4. Declared uncompressed size is at most 10,000,000 bytes per file and 30,000,000 bytes across the archive. These limits use decimal bytes, not MiB. Every reader MUST also enforce actual expanded sizes during decompression, before retaining data beyond a limit, and require actual size/CRC to match the directory. The same limits apply to display, signing, draft saves, and offline verification, including `manifest.json`.
5. Encryption and ZIP64 are unsupported. The ZIP64 extra field `0x0001` MUST be rejected.
6. Entry names are valid UTF-8. Non-ASCII names require the ZIP UTF-8 flag, bit 11. A Unicode-path extra field `0x7075`, if present in either header, MUST have version 1, a matching name CRC, and exactly the same decoded name as the central-directory name. Conflicting alternate names MUST be rejected.
7. Duplicate file names, duplicate directory names, and file/directory aliases MUST be rejected before a ZIP library can overwrite or normalize them. Directory names end with `/`; the remainder must satisfy the path predicate. A regular file cannot also be the parent of another entry.
8. All regular-file paths satisfy Section 4.2. Symbolic links and special Unix file types are unsupported. Directory entries have zero content size, compressed size, and CRC.

ZIP local and central headers MUST agree on the exact name bytes, flags, compression method, sizes, and CRC. Only flag bits 1/2 (DEFLATE options), 3 (data descriptor), and 11 (UTF-8) are supported; STORED entries MUST NOT set DEFLATE-option bits. A data descriptor may have its optional signature, but its CRC/sizes MUST match the central record. With bit 3 set, local CRC/sizes may be zero placeholders or the matching final values. Local record/data/descriptor ranges MUST be contiguous from offset zero to the central directory without overlaps, unindexed data, or executable preambles. The central directory may list those ranges in a different order. Container safety checks MUST precede decompression; actual size and CRC checks follow incrementally during bounded decoding. Implementations MUST NOT rely solely on a filename, a CRC, or an already-normalized entry map for integrity or path safety.

Cryptographic inventories cover logical regular-file paths after Section 4.4 root resolution and uncompressed bytes. The optional enclosing directory name is not in a cryptographic inventory. Compression level, entry order, ZIP timestamps, archive comments, directory entries, and the compressed byte representation are not signed by this format. Repacking without changing the file map preserves document/form signatures and seals, provided the new ZIP still satisfies this profile.

### 4.2. Safe archive paths

`SafePath(p)` is true exactly when:

1. `p` is nonempty and has at most 512 UTF-16 code units. Supplementary Unicode characters count as two units.
2. It contains none of `\`, U+0000–U+001F, U+007F, `:`, `%`, `?`, or `#`.
3. Splitting on `/` yields only nonempty segments. No segment equals `.`, `..`, `__proto__`, `constructor`, or `prototype`.
4. It does not start with `/`.

Forward slashes delimit segments. Spaces and well-formed Unicode are permitted. Names are case-sensitive. No leading `./`, absolute path, URI, drive prefix, URL encoding, or backslash alias is accepted as an archive path. Readers MUST preserve the original ZIP name long enough to check it before library normalization.

Examples: `wdoc-assets/logo.png` and `attachments/terms 2026.pdf` are safe; `/index.html`, `./index.html`, `a//b`, `a/../b`, `a%2fb`, `a\\b`, and `constructor/data` are not.

### 4.3. Namespace and classification

| Path or prefix | Meaning | In original inventory? |
| --- | --- | --- |
| `index.html` | Required root HTML entry point | Yes |
| `manifest.json` | Optional root integrity/signature manifest, version `1.0` when present | No; only its protected scope is digested |
| `wdoc-assets/` | Conventional local images, CSS, fonts, and other resources | Yes |
| `wdoc-attachment/` | Conventional original document attachments | Yes |
| `forms/<formId>.json` | Optional protected form descriptor recognized by signing preparation | Yes |
| `wdoc-form/` | Editable draft answers and draft file inputs | No |
| `submissions/` | Immutable answer snapshots and their attachments | No; separately committed |
| `revisions/` | Historical original files | No; verified against historical scopes |
| `seals/` | Whole-archive JWS and nonce files | No; separately committed |
| Any other safe file path | Original content/resource | Yes |

Only these four exact, case-sensitive prefixes are runtime prefixes: `wdoc-form/`, `submissions/`, `seals/`, `revisions/`. In particular, `wdoc-attachment/` is original content. A file named `submissions` without a slash is not in that runtime prefix. Producers SHOULD avoid such confusing names.

When a manifest is present, all non-runtime regular files except `manifest.json` MUST be listed in `content.files`; all listed originals MUST exist. Unknown non-runtime files are not silently ignored, including OS metadata files. A signature producer MUST NOT introduce files ending in `.js`, `.mjs`, `.cjs`, `.exe`, `.sh`, `.bat`, or `.cmd` anywhere, case-insensitively. New submission attachments have the additional restrictions in Section 9.3.

Under `seals/`, regular files have only `seals/<signatureId>.jws` or `seals/<signatureId>.nonce` names. Each seal MUST have exactly its matching JWS and nonce files; a file without its partner is invalid. Other runtime files may exist but are not implicitly authenticated by a document signature. A seal covers them as ordinary files.

### 4.4. Document root resolution

Readers MUST determine the logical document root exactly as follows, after checking the original ZIP entry names and container limits:

1. If a regular file named exactly `index.html` exists at ZIP root, ZIP root is the document root. Any number of safe resource/runtime directories MAY accompany it, even when another HTML file is named `index.html` inside a resource directory. No search or ambiguity selection occurs.
2. Otherwise, all central-directory entries MUST belong to exactly one top-level directory. No regular file or second directory, including an empty directory, may sit beside it. The enclosing directory's own explicit directory entry is OPTIONAL.
3. That sole directory MUST contain a regular file named exactly `index.html` immediately inside it. Readers MUST NOT search more deeply, choose among multiple folders, use locale ordering, or accept a case-insensitive spelling.
4. Strip exactly the enclosing directory prefix from every entry to obtain logical paths. Do not strip a second wrapper. Preserve every file's bytes, including any `manifest.json`, JWS, and nonce bytes.
5. All manifest paths, original inventories, form paths, revision maps, seal inventories, and resource references use these logical paths. A manifest is read only from the logical root. The physical enclosing directory name is not signed.

OS metadata has no exception to this root algorithm. For example, a second root `__MACOSX/` directory makes a wrapped layout invalid. In a root-index layout, safe metadata files are ordinary files and participate in a present manifest's inventory where their namespace requires it. A viewer MAY hide recognizable metadata from its attachment listing, but MUST NOT omit it from root selection, size limits, or cryptographic membership.

Exports SHOULD use the root-index layout. Repacking a document under one conforming enclosing folder, removing that folder, or renaming it preserves logical paths and signatures/seals. This is packaging resolution, not a modification of signed files. Both physical ZIP paths and resulting logical paths MUST satisfy Section 4.2; physical entries still count toward all limits.

### 4.5. Illustrative layout

```text
index.html
manifest.json
wdoc-assets/logo.png
wdoc-attachment/terms.pdf
wdoc-form/approval.json
wdoc-form/draft-proof.pdf
submissions/<submissionId>/answers.json
submissions/<submissionId>/attachments/1-proof.pdf
revisions/<oldDocumentDigest>/files/index.html
seals/<signatureId>.jws
seals/<signatureId>.nonce
```

Angle-bracket placeholders in this illustration are not literal paths.

## 5. HTML document and rendering

### 5.1. Entry point and resources

`index.html` MUST be at the logical document root defined in Section 4.4 and contain UTF-8 HTML. Producers SHOULD include a doctype, `html`, `head`, UTF-8 charset declaration, a title, and `body`. A fragment may be parsed by an HTML parser, but full HTML documents give more predictable metadata and resource handling.

Standard static HTML provides text, headings, lists, tables, images, links, and native form controls. Styles may be inline, in `style` elements, or in archive-local stylesheets. Local paths are interpreted relative to the containing resource. Raw HTML and CSS bytes are hashed; the sanitized/rendered DOM is not substituted into `content.files`.

The reference viewer turns local images, CSS images/fonts, and attachment links into temporary blob URLs. It resolves each local CSS reference relative to the containing stylesheet, including nested imports. Imports are expanded locally, preserving layer, supports, and media conditions; cyclic imports are omitted. Per rendering operation, at most 1,000 import expansions and 64 nested stylesheet paths are supported. Resolved CSS is limited to 30,000,000 UTF-16 code units across root stylesheets and style attributes, including the built-in stylesheet and before HTML serialization escaping. Exceeding these rendering limits reports an error. External CSS dependencies are removed without fetching; external-image consent is a separate behavior. Stylesheet text MUST NOT escape its serialized `style` element. Blob URLs and generated QR/barcode graphics are rendering artifacts and MUST NOT replace original file paths during integrity verification. A viewer MUST sanitize document HTML before injecting it. It MUST NOT execute document scripts. Shadow DOM provides style isolation in the reference viewer; it is not a standalone security sandbox.

### 5.2. wdoc elements

These elements are supported by the current renderer. Ordinary HTML attributes and allowed styles still apply; no wdoc-specific page-size attribute is defined.

| Element | Content and processing |
| --- | --- |
| `wdoc-container` | Container for direct child pages. Generated when pagination requires it. |
| `wdoc-page` | An explicit page. If any explicit pages exist, automatic pagination is skipped. |
| `wdoc-content` | Main page body between the header and footer; inserted if absent. |
| `wdoc-header` | Repeated header template. The first occurrence is cloned to every page; source occurrences are removed. |
| `wdoc-footer` | Repeated footer template with the same first-template rule. |
| `wdoc-pagenum` | Text content replaced with the one-based page number. |
| `wdoc-nbpages` | Text content replaced with the total direct page count. |
| `wdoc-date` | Text content replaced with the local rendering date, using optional `format`. |
| `wdoc-barcode` | Trimmed text content encoded as a QR or supported linear barcode. |

Authors SHOULD provide one container with direct child pages, at most one header template, and at most one footer template. The footer element name is `wdoc-footer`. `wdoc-qr` and `wdoc-totalpages` are not supported element names in this version.

If no page exists, the viewer paginates the sanitized content locally. Current defaults are page width 793.8 CSS px, height 1122 CSS px, padding 20 CSS px, 20 CSS px inter-page gap, font size 16 CSS px, and line height 1.6. Measured styles and header/footer height affect layout. The current default font stack is `"Inter", "Helvetica Neue", Arial, sans-serif`. These defaults describe the viewer profile; page count and pixel output are not cryptographic invariants. Browser font metrics, CSS support, dynamic placeholders, and display environment may change the rendering of identical signed bytes.

`wdoc-pagenum`, `wdoc-nbpages`, and `wdoc-date` are expanded within pages. A producer MUST NOT represent the dynamic date as a signing time. A viewer SHOULD distinguish such generated text from stored metadata where that distinction matters.

### 5.3. Date placeholders

`wdoc-date` has optional `format`, default `dd/mm/YYYY`. The reference renderer obtains one local date for the render operation and applies replacements in this order:

1. Replace every `YYYY`, then every `Y`, with the full year.
2. Replace every `MM`, then every `mm`, with the two-digit month.
3. Replace every `DD`, then every `dd`, with the two-digit day.

There is no token escaping, locale expansion, time-of-day token, or time-zone token. Other characters remain literal. Example: `<wdoc-date format="YYYY-MM-DD"></wdoc-date>`.

### 5.4. Barcodes

`wdoc-barcode` uses its trimmed text content as the encoded value. Empty values are removed. Attribute `type` is case-insensitive and defaults to `qrcode`.

For QR codes, `errorcorrection` accepts `L`, `M`, `Q`, or `H`, case-insensitively; absent/invalid values select `M`. Generated output is an image within the element. `aria-label` defaults to `QR code`.

Supported linear type names are `codabar`, `code128`, `code39`, `ean`, `ean8`, `ean13`, `itf`, `itf14`, `msi`, `pharmacode`, `upc`, `upca`, and `upce`. These are passed as uppercase library format names; actual value validity and format aliases follow the renderer's barcode library. Generated output is SVG; class, style, height, width, and accessibility attributes are copied where supported. Generation failures fall back to text; an unknown type leaves the element's text unencoded. A barcode does not itself sign or authenticate its value.

### 5.5. Self-contained static integrity profile

Manifest 1.0 integrity verification uses this resource profile locally, including for unsigned version-1.0 archives:

1. Inspect every original whose extension is `.html`, `.htm`, `.svg`, or `.css`, case-insensitively. HTML parsing includes template contents.
2. Reject `base`, `iframe`, `object`, `embed`, `script`, SVG animation elements `animate`, `animateMotion`, `animateTransform`, `set`, and `foreignObject`.
3. Reject `srcset`. Inspect every `src`, `poster`, and non-anchor `href`; inspect inline `style` and `style` element contents.
4. Empty references and references beginning with `#` do not identify another file. Supported data-URL prefixes are raster `image/png`, `image/jpeg`, `image/jpg`, `image/gif`, `image/webp`, `image/avif`, `font/`, `application/font`, and `application/octet-stream`, matched case-insensitively. A data URL does not cause a network request.
5. Resolve other references using a synthetic `https://archive.invalid/<containing-path>` base. The resulting origin MUST equal that synthetic origin. Percent-decode the URL pathname once, remove its initial slash, and require a safe path that is a member of the protected original inventory. Runtime files MUST NOT supply rendering dependencies.
6. In CSS, replace the exact escape `\200B` or `\200b` immediately before a single or double quote with U+200B for dependency analysis. Reject all remaining backslashes and any case-insensitive `image-set` followed by optional whitespace and `(`. Remove CSS comments for scanning. Resolve references found in quoted/unquoted `url(...)` and quoted `@import`.

Step 6 is a deliberately restricted dependency recognizer, not a general CSS parser or a guarantee of sanitizing every browser feature. The typographic escape exception permits the existing empty-paragraph styles; it does not alter the bytes being hashed. Authors SHOULD use plain local references without query strings, URL escapes, or complex dependency constructs. Anchor `href` targets are navigation, not protected rendering dependencies; their existence or destination is not authenticated beyond the anchor's stored bytes.

External images may be offered through a consent prompt during unsigned display. That viewer capability does not make an external dependency conform to this integrity profile. No signing request uploads an archive to compensate for an unsupported rendering dependency.

## 6. Manifest

### 6.1. Top-level object

`manifest.json` is OPTIONAL. If absent, the document is unsigned and no manifest version is inferred. If present, it MUST contain one complete version-1.0 JSON object with this structure:

```text
{
  manifestVersion: "1.0",
  meta: Meta,
  content: Content,
  runtime: Runtime,
  signatures: {document: DocumentSignature[], forms: FormSignature[]}
}
```

All five members are REQUIRED. A new producer MUST NOT write other top-level members. `meta`, `content`, and `runtime` are extension points as described below. `signatures` has exactly `document` and `forms`, both arrays, including when empty. The archive manifest is unrelated to a web application's PWA manifest.

### 6.2. Metadata

| Member | Type | Required | Meaning |
| --- | --- | --- | --- |
| `docId` | identifier | Yes | Stable document identifier retained across content revisions |
| `appVersion` | nonempty string | Yes | Producer application version; not the format version |
| `createdAt` | date-time string | Yes | Declared document creation time |
| `contentUpdatedAt` | date-time string | Yes | Declared update time of this original content scope |
| `docTitle` | string | No | Human-readable title |
| `creator` | string | No | Informative creator label; current writer sets it only from an authenticated account email |
| `docVersion` | string | No | Author-facing document version; editor default `1.0.0` |

Additional JSON members MAY appear in `meta`. All are protected by the original digest, including members the reader does not understand. A creator label is not proof of ownership or signer identity. The `docId` is an identifier, not an access credential or a server lookup key.

### 6.3. Content

`content.hashAlgorithm` MUST be exactly `"SHA-256"`. `content.files` MUST be an object mapping each original file path to `H(actual file bytes)`. `index.html` MUST be present as a member. `manifest.json` and runtime paths MUST NOT be members. The map represents the complete original set, not a selected subset.

Additional JSON members MAY appear in `content`; they are protected as opaque extensions. The only defined content digest is `Digest(M)` in Section 7.

### 6.4. Runtime

| Member | Type | Required | Meaning |
| --- | --- | --- | --- |
| `submissions` | object mapping form IDs to arrays | Yes | Submission descriptors, possibly empty |
| `revisions` | array | Yes | Historical protected scopes, paths, and signatures |
| `forms` | object | No | Editable draft inventory sections; writer emits `{}` when absent |
| `updatedAt` | date-time string | No | Informative last runtime update |

Other JSON members MAY appear in `runtime`. Runtime metadata is excluded from the original digest. Its membership in the manifest does not authenticate it. The separately committed fields in Sections 9, 10, and 15 supply their specified guarantees.

### 6.5. Signature wrappers

A document signature wrapper is:

```text
{signatureId: identifier, jws: compact-JWS, nonce?: nonce}
```

A form signature wrapper is:

```text
{signatureId: identifier, jws: compact-JWS, nonce?: nonce,
 formId: identifier, submissionId: identifier}
```

No other members are written in these wrappers. The nonce is REQUIRED in every signature wrapper. Historical original signatures use the document wrapper in each revision's `signatures` array. Local wrappers and their array order are outside the protected original scope. Their relationship to signed commitments MUST be checked rather than assumed.

## 7. Original content integrity

### 7.1. Inventory construction

For every original file path `p`, calculate `H(F[p])` over its exact uncompressed byte sequence. Construct a JSON object from these path/hash pairs. Inventory ordering has no semantic meaning; canonicalization supplies deterministic ordering when the object is committed.

Content verification succeeds only if every listed original exists, every file hash matches, no extra original exists, paths are safe, and the static dependency profile succeeds. Runtime entries do not become originals just because they are referenced by HTML; such rendering references are prohibited.

### 7.2. Protected scope digest

Compute:

```text
S = {manifestVersion:M.manifestVersion, meta:M.meta, content:M.content}
D = H(UTF8(JCS(S)))
```

`D` is the document digest. Do not include `runtime`, `signatures`, ZIP bytes, or the raw manifest serialization. Do not extract only known metadata members: the full `meta` and `content` objects, including unknown members, are REQUIRED.

Adding an independent signature, saving a draft, or appending a submission leaves `D` unchanged if the protected scope and original files are unchanged. Editing `meta.docTitle`, an auxiliary content field, or one byte of any original requires a new scope and a new original attestation.

An attacker can replace both an unsigned file and its unsigned hash. Accordingly, inventory success alone MUST be reported as unauthenticated integrity, not trusted authenticity.

## 8. Editable form drafts

### 8.1. Draft file naming and values

Draft answers are JSON objects in `wdoc-form/<form-id>.json`. For an explicit HTML form `id`, the current saver uses that ID. Otherwise it emits `form-N.json`. Draft values are generally strings obtained through browser `FormData`; file inputs store an attachment filename whose bytes also reside in `wdoc-form/`.

The draft format does not preserve repeated values as arrays: successive values for a name overwrite earlier values in the object. An unchecked checkbox omitted by `FormData` is absent. Saving a draft is distinct from creating a signed answer snapshot.

The restoration algorithm first matches an exact form DOM ID. If no such form exists, an entire basename matching `form-N`, with positive decimal `N` and no leading zero, selects the one-based position among all document forms. It matches controls by their exact `name` value without interpreting answer names as CSS selectors. Checkbox values `"true"`, `"on"`, or `"1"` restore a checked state; a radio group selects the control whose value equals the stored string. Other controls receive the string value. A saved file is exposed as a downloadable local link; browsers do not restore it into a file-input selection. Draft JSON is parsed with the same duplicate-name and UTF-8 rules; malformed/non-object draft files are ignored rather than applied as answers.

The saver MUST calculate fallback `N` from the position among all forms, matching snapshot collection. Explicit IDs MUST be safe identifiers. Resulting answer filenames MUST be unique; an explicit `form-2` colliding with an unnamed second form is rejected. Draft attachments MUST NOT overwrite an answer JSON filename or another newly collected attachment with the same filename. Authors SHOULD use stable explicit IDs when exchanging drafts.

### 8.2. Draft inventories and guarantees

`runtime.forms`, when present, maps section names to objects containing exactly `{hashAlgorithm:"SHA-256", files:Inventory(draftFiles)}`. All inventory paths MUST be safe paths under `wdoc-form/`; hashes use the same canonical base64url SHA-256 encoding as original files. The editor writes one section named `default`. These inventories are optional descriptive draft metadata, not signed snapshots or an additional original digest.

Neither draft files nor these runtime inventories are protected by an original signature. Under manifest 1.0, editing drafts can preserve every original/form signature but invalidate existing seals. A reader MUST NOT display draft values as signed answers merely because a signed submission exists for that form. Signed answers must be read from the immutable submission paths.

## 9. Immutable form submissions

### 9.1. Descriptor

For each form ID, `runtime.submissions[formId]` is an array of objects with exactly these members:

| Member | Type | Required | Constraint |
| --- | --- | --- | --- |
| `submissionId` | identifier | Yes | Globally unique within the archive |
| `answersFile` | safe path | Yes | Exactly `submissions/<submissionId>/answers.json` |
| `attachments` | array of distinct safe paths | Yes | Every member starts with `submissions/<submissionId>/attachments/` |
| `createdAt` | date-time string | Yes | Informative local creation time |
| `documentDigest` | digest | Yes | Protected original revision to which the answers relate |
| `replaces` | identifier | No | Informative reference to a previous submission of the same form |

The current producer writes one-level attachment names, not subdirectories. It chooses an HTML form's explicit ID or its one-based position among all parsed forms as `form-N`. It also recognizes the existence of a protected `forms/<formId>.json` as a form declaration; this version defines no descriptor vocabulary or validation engine for that file.

The answer file and every enumerated attachment MUST exist when signing or verifying the snapshot. The signature commits to the exact set of these files. Other files under `submissions/` are not automatically covered by this form's signature; only a seal provides full-archive membership integrity.

### 9.2. Answer serialization

A new local signing operation writes `answers.json` as `UTF8(JCS(answers))`, without a trailing newline. The lower-level local signing interface accepts a JSON value; the standard HTML collection profile produces an object whose member names are control names and whose values are ordered arrays.

For the HTML collection profile:

1. Browser form validation must succeed before review. Enumerate the browser's `FormData(form)` entries in their specified order.
2. Append each string value to its name's array, preserving repeated values. These are strings even when the input is a number or date control. Disabled or otherwise unsuccessful controls follow browser `FormData` behavior.
3. A selected file contributes `{attachment:<local-filename>,size:<byte-count>}` and copies its exact bytes into the snapshot attachments. Selected empty files with a filename are represented as files.
4. A previously saved draft attachment can be copied into the snapshot with `{attachment:<local-filename>}`; the current collector omits its size member.
5. An empty file selection without a saved attachment contributes `null`.
6. For every named checkbox/radio group without collected values, add an empty array. This explicitly represents an unchecked group. It does not inject `false` into other arrays.

Attachment filenames are prefixed with a one-based counter in collection order, for example `1-proof.pdf`. The full archive path adds the submission prefix. Answer attachment descriptors are review metadata inside the hashed answer file; the authoritative snapshot file set is the descriptor's `answersFile` plus `attachments` array. Applications SHOULD check their semantic agreement before presenting a review. The core verifier hashes files and does not validate an application-specific answer schema.

### 9.3. Attachment restrictions

New submission attachment names MUST satisfy `SafePath`, contain no slash, and MUST NOT end with `.html`, `.htm`, `.svg`, `.js`, `.mjs`, `.cjs`, `.exe`, `.sh`, `.bat`, or `.cmd`, case-insensitively. Limits from Section 4.1 apply. These restrictions reduce active-content exposure; a signature does not certify that a binary attachment is harmless. Viewers MUST NOT execute attachments as document code.

### 9.4. Co-signatures and corrections

Co-signers commit independently to the same submission ID and unchanged answer/attachment bytes. Each signature has its own local nonce, signer, and JWS. The current local producer co-signs only submissions of the current original digest; historical submissions remain verifiable but cannot be newly co-signed through that preparation path.

A correction MUST create a new submission ID and new immutable files. It MAY set `replaces` to the old submission ID. `createdAt` and `replaces` are not in the form commitment defined below. Consequently, the form signature alone MUST NOT authenticate their values, prove a correction chain, or authorize hiding the old submission. A whole-archive seal authenticates their stored bytes as part of the manifest snapshot.

## 10. Content revisions

Editing an original or protected metadata creates a new protected scope. The current revision operation preserves `docId` and `createdAt`, updates `contentUpdatedAt`, `appVersion`, and `docTitle`, rebuilds `content.files`, and starts an empty current document-signature array. Old form signatures and submissions are retained with their original `documentDigest`.

Each member of `runtime.revisions` has exactly:

```text
{
  scope: {manifestVersion:"1.0", meta:Meta, content:Content},
  files: {<originalPath>:<archivedPath>, ...},
  signatures: DocumentSignature[]
}
```

For a historical scope `R`, calculate `d = Digest(R)`. Every archived path MUST equal:

```text
revisions/<d>/files/<originalPath>
```

The file map MUST provide exactly the historical original paths in that scope, with the original name as the map key. Historical scopes MUST retain the current document's `docId`. Their digests MUST be distinct from each other and from the current scope digest; duplicated scopes are structurally ambiguous and rejected. Signature IDs MUST remain unique across current, form, historical, and seal signatures. For verification, reconstruct a temporary original-name file map and use `R.content.files`, `R.meta`, and the old signature nonces/JWS values. Do not hash the new archive path as though it had been the old original path. Historical scopes retain their own protected metadata and dependencies. These structural requirements do not impose chronological order or create a signed parent chain.

Revision array position is informative. There is no signed parent pointer or monotonic revision counter in this format. An original signature authenticates its own scope, not the existence, order, or completeness of all historical revisions. Readers MUST NOT infer a global revision history from this array without an external retained reference. Seal verification may establish the integrity of the supplied history snapshot only.

## 11. JWS and key policy

### 11.1. Compact serialization

Every signature is a compact JWS under [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515), with an embedded base64url payload. The JOSE algorithm is exclusively `ES256`, using a public EC P-256 JWK. The JOSE signature is the 64-byte concatenation of unsigned fixed-width `R` and `S`; it is not ASN.1 DER. The signing input is the two original encoded header/payload segments separated by `.`. A verifier MUST verify that input directly, not a reserialized payload.

Producers sign `UTF8(JCS(payload))`. Existing readers accept a correctly signed noncanonical JSON payload after validating its JSON value; canonical production is required for new signatures. Detached payloads, unencoded payloads, JWS JSON serialization, `none`, HMAC, and other algorithms are not part of this profile. The authentication session JWT is a separate protocol artifact and MUST NOT be used as a document signature.

### 11.2. Protected header

The producer's protected header contains exactly:

```json
{"alg":"ES256","typ":"wdoc-document+jws","kid":"https://sig.wdoc.info/info/key-version"}
```

Replace `typ` with `wdoc-form+jws` or `wdoc-seal+jws` for the corresponding kind. `kid` selects an externally registered key. Header order is not significant; all three fields must be protected. The types are separate validation contexts: a form JWS MUST NOT be accepted as a document or seal JWS.

Producers MUST NOT emit `b64`, `crit`, `jku`, embedded `jwk`, `x5u`, or other header extensions in this profile. Readers MUST reject every unknown header member, even if its value is false, null, or an empty array. The header is parsed with fatal UTF-8 and duplicate-name detection before key selection; the JOSE library's default JSON parsing is insufficient. Verification MUST reject an unencoded-payload option, algorithm/type mismatch, missing KID, or a request for dynamic/uncontrolled key resolution.

### 11.3. Registry record

A configured key registry contains records of this form:

```text
{
  kid: HTTPS-URL,
  jwk: public-EC-P256-JWK,
  status: "active" | "retired" | "revoked",
  trusted: boolean,
  authority: "platform" | "personal",
  owner: nonempty-string,
  userId?: nonempty-string,
  notBefore?: date-time,
  expiresAt?: date-time
}
```

Public keys follow [RFC 7517](https://www.rfc-editor.org/rfc/rfc7517). They contain `kty:"EC"`, `crv:"P-256"`, and 43-character B64U `x` and `y` coordinates. A private `d` member MUST NOT be present. If present, `alg` is `ES256`, `use` is `sig`, and `key_ops` contains `verify`.

KIDs MUST be unique, use HTTPS, have an origin in the externally configured exact allow-list, and have pathname `/info/<key-id>` where `key-id` contains only ASCII letters, digits, `_`, and `-`. User information, query, and fragment are prohibited. The origin allow-list and trust flags MUST NOT be taken from the archive. KIDs are compared as registered strings; a verifier MUST NOT fetch an arbitrary KID URL selected by a document. The configured registry is the lookup authority, even if a public JWK is available at that URL.

Offline verification receives exactly `{keys:[...],allowedOrigins:[...]}` from an independently trusted source. Online lookup uses the application's configured backend, not arbitrary document-selected servers. The browser validates the same record fields, unique KIDs, usage, valid public curve points, and origins as the server/CLI. Its independent `backend.signingKeyOrigins` configuration is set in both development and production builds; the default is `["https://sig.wdoc.info"]`. A response's optional `allowedOrigins` is not an authority to expand that list. Invalid registry responses yield unavailable keys and never preserve trust from an earlier response. HTTPS delivery alone does not justify trusting an archive-supplied key. If both key validity endpoints exist, `notBefore` MUST be earlier than `expiresAt`.

### 11.4. Authorization and time policy

`active` keys can issue new signatures when all other authorization rules pass. `retired` public keys can verify old signatures but MUST NOT issue new platform attestations. `revoked` keys are unauthorized. At verification time `t`, a key is unauthorized if `t < notBefore` or `t >= expiresAt`. Declared `signedAt` does not override current revocation/expiry policy.

Document and seal signatures require `authority:"platform"`. Form signatures require `mode:"wdoc-attestation"` for a platform key or `mode:"personal"` for a personal key. A personal record MUST have `userId`, and the signed `signer.userId` MUST equal it. A platform service derives the signed account identity from the authenticated session. `owner` is the policy's key label, not automatically the person who filled a form.

A mathematically valid, authorized signature with `trusted:false` is `valid-untrusted`. Readers MUST NOT promote it to a trusted identity. Invalid or unavailable key policy is not a reason to skip verification or mark success. Key issuance, proofing, revocation distribution, and private-key custody are operator/provider responsibilities.

## 12. Randomized commitments

### 12.1. Construction

For each new document, form, or seal signature, generate an independent unpredictable 32-byte nonce on the client. Define:

```text
C(kind, value, n) = H(UTF8(JCS({
  domain: "wdoc-" + kind + "-commitment-v1",
  nonce: n,
  value: value
})))
```

Only `kind` values `document`, `form`, and `seal` are defined. Exact domain strings are `wdoc-document-commitment-v1`, `wdoc-form-commitment-v1`, and `wdoc-seal-commitment-v1`. The nonce is a JSON string, not raw concatenated bytes. The `value` is the JSON value specified below, not a pre-serialized JSON string unless explicitly stated.

Nonces MUST use a cryptographically secure random generator. They MUST NOT be derived from filenames, answers, document hashes, account identity, a time, or a reused constant. A retry of the same prepared operation retains its nonce and request ID; a distinct signature operation generates a new nonce. Domain separators MUST NOT be changed without a versioned compatibility decision.

### 12.2. Privacy boundary

The nonce stays in the local archive and MUST NOT be sent to the platform attestation service. Likewise, the platform MUST NOT receive the manifest, raw document digest, original file hash inventory, filename, document/form/submission IDs, answer values, or attachment bytes as part of signing. Request fields are exhaustively specified in [WDOC-ATTESTATION](attestation-protocol.md).

Recipients possessing the archive also possess its nonces and can recompute commitments. This privacy property is against the commitment service without the archive/nonces; it is not encryption of the archive and is not a claim of a zero-knowledge proof. Identity and service timing remain visible to that service.

## 13. Original document signatures

Let `D = Digest(M)` and let `n` be the wrapper's nonce. The signed value is:

```text
documentCommitment = C("document", D, n)
```

The payload contains exactly:

```text
{
  type: "wdoc-document-signature",
  proofMode: "digest-only",
  documentCommitment: digest,
  signer: {userId: nonempty-string, displayName: string},
  signedAt: date-time,
  evidence: {
    method: "authenticated-session",
    consent: "wdoc-sign-v1",
    scope: "commitment-only"
  }
}
```

The JWS is stored with its signature ID and nonce in `signatures.document`, or in a historical scope's `signatures` array. No `docId`, `documentDigest`, title, path, or nonce occurs in the payload. `displayName` is the platform account email in the current service; its interpretation comes from that service's identity policy.

To verify, validate the JWS as a document signature, verify its platform authority, recompute `D` and the commitment, then verify the entire original file set and dependencies. A commitment mismatch is `wrong-revision`. A correct commitment with damaged original content is `file-modified`. Successful document verification does not authenticate runtime membership or drafts.

The platform attestation means the account requested a signature of that commitment with the stated evidence. It does not mean the platform saw the document, confirmed authorship/ownership, validated the form, or inspected the attachments.

## 14. Form signatures

### 14.1. Snapshot commitment

For submission `s` of form `f`, construct `SF` from exactly `s.answersFile` and `s.attachments`, with their actual bytes. Let:

```text
V = {
  docId: M.meta.docId,
  documentDigest: s.documentDigest,
  formId: f,
  submissionId: s.submissionId,
  files: Inventory(SF)
}
submissionCommitment = C("form", V, formSignatureNonce)
```

This commits to names and bytes of the complete enumerated snapshot, its form/submission IDs, and its declared original digest. Array order of `attachments` is not included; inventory membership is. `createdAt`, `replaces`, runtime extension members, signature IDs, and unrelated files are not part of `V`.

### 14.2. Payload and original binding

The payload contains exactly the common members in Section 13, with `type:"wdoc-form-signature"`, and adds:

```text
mode: "wdoc-attestation" | "personal"
submissionCommitment: digest
```

`documentCommitment` MUST match a trusted, successfully verified commitment-mode original signature of the scope identified by `s.documentDigest`. The current producer selects a verified signature of the current scope and sends its JWS as `documentProof`. A form verifier may bind historical submissions to a successfully verified historical original. Mere equality to any untrusted document commitment is insufficient.

Verification finds the submission by wrapper `formId` and `submissionId`, establishes its trusted original binding, reconstructs `V`, and compares its commitment using the wrapper nonce. No matching trusted scope is `wrong-revision`; missing snapshot bytes, nonce failure, or a snapshot commitment mismatch is `file-modified`.

### 14.3. Modes and evidence

For `wdoc-attestation`, authority MUST be platform. `signer` and `evidence` have the exact Section 13 structure. Evidence means an authenticated session and explicit client consent, not a fresh transaction OTP, passkey assertion, or individual possession of a private key.

For `personal`, authority MUST be personal and `signer.userId` MUST match the enrolled key record. The current personal producer sets `signer.displayName` to the registry owner label and `evidence` to `{scope:"commitment-only"}`. The reader permits the same optional method/consent constants in personal evidence, but a producer MUST NOT claim platform authentication without that evidence being true. The private key is held by the selected local signing provider. The prepared local state contains confidential data and MUST NOT be passed to a remote provider as though it were the JWS payload.

## 15. Archive seals

### 15.1. Inventory and storage

A seal is a platform JWS with a local nonce sidecar. For seal ID `i`, the two file paths are:

```text
seals/<i>.jws    UTF8(compact JWS), no newline
seals/<i>.nonce  UTF8(nonce string), no newline
```

There is no manifest seal-wrapper array. When building this seal, let `AF` contain every regular file in the logical archive, including the actual `manifest.json` bytes and all prior seal/nonce pairs. Exclude exactly the two paths above for this seal, whether or not they already exist. Calculate:

```text
archiveCommitment = C("seal", {
  docId: M.meta.docId,
  files: Inventory(AF)
}, sealNonce)
```

A producer MUST finalize all other files, especially the manifest, before computing the commitment and MUST NOT change those bytes when inserting its own pair. If an in-memory document has no manifest serialization yet, the reference local implementation uses `UTF8(JCS(M))` as the serialization and exports those same bytes. A verifier of an archive MUST use its actual manifest bytes, not substitute canonical JSON.

### 15.2. Payload and verification

The payload contains exactly the common members in Section 13, with `type:"wdoc-seal-signature"`, plus `archiveCommitment`. It contains no path list or local nonce. Its `documentCommitment` binds to a verified trusted original signature. The current producer selects the current original proof; the verifier can recognize a trusted proof in the current or a historical scope.

A verifier MUST validate the JWS, the trusted original binding, the local nonce, and the complete current file inventory excluding only the seal's own pair. A missing trusted original binding is `wrong-revision`. Missing/modified nonce or inventory inequality is `archive-changed`. Checking only listed files without comparing the complete membership is insufficient.

Before producing a seal, the current local workflow requires all current document, form, and historical signature results to be `valid-trusted`, including rejecting unsigned submissions. Prior seals are not required to remain current. Seal verification is separate from checking each embedded signature; it does not make an invalid embedded signature valid.

### 15.3. Mutation and completeness limits

Adding any file, signature, submission, revision, or later seal pair changes the inventory seen by an older seal. Editing manifest whitespace also changes it. The old seal then reports `archive-changed`; original and form signatures can remain valid. An additional seal can protect the new supplied snapshot, including the old seal pair.

This is a snapshot seal, not proof that the snapshot is globally latest. Deleting the last seal, removing a suffix of later history, or reverting the whole archive to an older valid copy cannot always be detected without an independently retained reference. Neither an unsealed manifest nor the minimal service journal proves that no signature or submission was removed. Applications MUST NOT promise deletion detection or rollback prevention beyond the supplied sealed snapshot.

## 16. Creation and mutation procedures

### 16.1. New document

1. Assemble root `index.html` and all original assets locally.
2. Check container/path restrictions and the static dependency profile.
3. Construct `meta`, inventory all originals, and create `manifestVersion:"1.0"` with empty submission/revision/signature structures.
4. Serialize `manifest.json` and generate the ZIP. The editor may pretty-print it; a signature workflow may use JCS.
5. An original signature is optional. If requested, prepare its commitment locally, obtain explicit consent, request an attestation, verify the returned JWS and claims, and atomically insert the wrapper plus nonce.

### 16.2. Signed form or co-signature

1. Verify the current original files and a trusted commitment-mode original signature. Resolve the form ID from original content.
2. Freeze the answer bytes and attachment set in a clone of local state, or select an existing unchanged current-revision submission for co-signing.
3. Present the frozen snapshot, downloadable attachment bytes, and signer/evidence meaning for review. Require explicit consent.
4. Compute the commitment, generate a request UUID, and send only the allowed protocol body.
5. Verify the returned JWS, kind, trusted key, account identity, and every expected commitment. Validate the new signature ID and reject collisions.
6. Commit the cloned snapshot, descriptor, wrapper, and nonce together. A failure MUST leave the source document unchanged.

### 16.3. Revision or seal

A revision prepares historical file copies and the new scope in a clone, validates the new original set, and commits it only after a verified new original attestation. A seal prepares its entire inventory before requesting attestation, then adds only its own pair. Download/export is local ZIP construction; it is not a server upload.

Concurrent local signature operations are rejected by the current service. A retry of an unchanged prepared operation reuses the same request UUID, files, commitments, and nonce. A changed source/input/account creates a distinct preparation. A result for one open document MUST NOT be applied to a different document that became active while the request was pending.

There is no global server version counter or automatic merge of independent document copies. The local in-memory `version` and base64 file map used by the frontend service are implementation state, not members of `manifest.json` and not an additional wire format.

## 17. Verification procedure and results

### 17.1. Ordered checks

A verifier MUST perform the following logical checks. Independent checks may run concurrently, but later trust decisions depend on the stated bindings:

1. Validate the ZIP container, original names, entry count, paths, and expanded-size policy. Do not render yet.
2. Resolve the logical document root under Section 4.4 and validate entry-point UTF-8. If no logical-root manifest exists, report an unsigned archive without inventing a document digest or claiming verified files; do not interpret other files as authenticated signatures. If a manifest exists, read its actual bytes, parse JSON without duplicate keys, and require manifest version `1.0`. Validate required structures and semantic path/ID constraints; distinguish a malformed archive from a signature failure.
3. Compute the current protected scope digest. Verify exact original membership, hashes, and static dependencies.
4. Verify each current document JWS under its expected kind and registry policy; verify its nonce/commitment binding; combine with original integrity.
5. Reconstruct each historical original map at its exact digest-based path. Verify its scope, files, dependencies, and individual original signatures.
6. For each form signature, locate its descriptor, establish a trusted current/historical original binding, and verify its exact snapshot commitment.
7. For every submission with no form-signature wrapper, report `unsigned`.
8. Verify each seal against the actual complete file map and its appropriate original binding. Do not substitute parsed/canonical manifest bytes.
9. Return separate current-content, current-document, form, revision, and seal results. An absent original signature yields an `unsigned` document result; an absent seal yields no seal result and no completeness guarantee.

Parsing/shape exceptions may abort archive verification. They MUST NOT be converted into a successful partial result. Network/key lookup failure must remain distinguishable from valid cryptography and trusted identity.

### 17.2. Status vocabulary

| Status | Meaning |
| --- | --- |
| `valid-trusted` | Cryptography, expected binding, relevant bytes, and configured key trust succeeded for this check |
| `valid-untrusted` | Mathematical/inventory check succeeded without authenticated trusted identity; also used for a matching unsigned content inventory |
| `file-modified` | Original or snapshot files, membership, dependency rules, or snapshot opening do not match the expected scope |
| `invalid-signature` | Malformed JWS/payload, failed signature math, or invalid commitment-profile payload |
| `key-unavailable` | No registry record for the JWS KID |
| `key-unauthorized` | Algorithm/header policy, authority/mode, key status, type, or current validity policy prohibits the key |
| `wrong-revision` | Document/snapshot reference or original commitment does not bind to the expected trusted scope |
| `unsigned` | No manifest or original signature, or a submission has no signature wrapper |
| `archive-changed` | A seal cannot be opened against the supplied complete archive snapshot |

The reference report is `{documentDigest,content,document,forms,seals,revisions}`. For a manifestless archive, `documentDigest` is null, `content.status` and `document[0].status` are `unsigned`, and the other arrays are empty. A local signing client MAY prepare a fresh candidate manifest in memory for review; this candidate does not authenticate the input and is persisted only in a deliberate local export/signing operation. `content` is one check; other result members are arrays. Checks may include `signatureId`, `formId`, `submissionId`, `kid`, registry `owner`/`authority`, verified `signer`, `signedAt`, explanatory `detail`, and `proofMode`. These report fields are not archived signature claims. In a seal report, the reference implementation uses the whole seal JWS path as `signatureId`.

### 17.3. Failure precedence and presentation

JWS verification first evaluates protected-header restrictions, key availability/status, signature math, payload JSON/type/date, authority/mode, then commitment-profile shape. A verified payload can subsequently fail its scope binding or file check. The current implementation may report a binding mismatch in preference to an untrusted-key result when both apply; a UI MUST NOT infer trust from residual signer labels on a failed check.

Original content failure downgrades otherwise valid current original signatures to `file-modified`. Missing form bindings yield `wrong-revision` before snapshot comparison; snapshot opening exceptions yield `file-modified`. Seal binding failures yield `wrong-revision`; seal opening exceptions yield `archive-changed`. A malformed historical path may abort the report. Diagnostics are not a stable machine protocol beyond the status vocabulary and report structure.

A viewer may refuse to render damaged original content even while a separate verifier can report remaining checks. It MUST make clear which original revision and submission a displayed signature concerns. A trusted original signature MUST NOT visually imply that an editable draft is signed, an archive is sealed, or all historical signatures are valid.

## 18. Archive conformance examples

The following table describes structural layouts, assuming safe ZIP records, paths, sizes, and UTF-8 HTML. A present manifest and signatures still require their own validation.

| ZIP entries | Result |
| --- | --- |
| `index.html` | Valid unsigned document; no signature material is required |
| `index.html`, `images/logo.png`, `styles/main.css` | Valid root document with multiple resource directories |
| `report/index.html` | Valid unsigned document in one enclosing folder |
| `report/index.html`, `report/images/logo.png` | Valid; logical paths are `index.html` and `images/logo.png` |
| `report/index.html`, `report/manifest.json`, `report/seals/...` | Valid layout; evaluate manifest/signatures at the logical root |
| `first/index.html`, `second/index.html` | Invalid: multiple root folders |
| `report/index.html`, `empty/` | Invalid: a second root folder, even if empty |
| `report/index.html`, `readme.txt` | Invalid: a root file beside the enclosing folder |
| `report/index.html`, `__MACOSX/._index.html` | Invalid: a second root folder |
| `outer/inner/index.html` | Invalid: entry point is not immediately inside the sole enclosing folder |
| `INDEX.HTML` or `report/Index.html` | Invalid: entry-point spelling is case-sensitive |
| `manifest.json` without an entry point | Invalid: no HTML entry point |

A producer MAY write only `index.html` and add optional features later. Before producing a signature, it MUST create a complete manifest, inventory every original at its logical path, validate static signing dependencies, and obtain explicit consent. The original HTML/resources remain local. Merely opening a manifestless archive MUST NOT rewrite it or initiate an attestation request.

## 19. Versioning and extensions

`manifestVersion` is the exact string `"1.0"`. `appVersion`, `docVersion`, editorial specification revision, local memory version, request UUIDs, and commitment-domain versions are distinct concepts and MUST NOT be interchanged.

`meta`, `content`, and `runtime` permit extension JSON members. Unknown protected members remain in JCS hashing. Unknown runtime members provide no authenticated semantics unless included in another explicitly defined commitment. Closed payloads, wrappers, and the signing API MUST NOT gain extra fields without an updated specification/schema and compatibility decision. This version has no critical-extension negotiation mechanism.

`proofMode` MUST be exactly `"digest-only"` in every signature payload. A present manifest MUST declare `manifestVersion:"1.0"` and all required structures. Missing versions, another version, missing wrapper nonces, inventory-bearing payloads, and partial manifest objects MUST be rejected. Readers MUST NOT construct a replacement manifest when an invalid manifest file is present. A completely absent manifest is valid under the base document profile in Sections 1 and 4.

This alpha specification defines the current format directly, without earlier profiles, migration procedures, or an editorial revision history. The current manifest version is `1.0`, the cryptographic algorithms are SHA-256 and ES256, and commitment domains are the three `v1` strings in Section 12.
A change to protected-scope extraction, hashing, path classification, snapshot membership, a commitment's JSON value, or a domain separator is a format change even if the TypeScript types do not change. Such changes require a deliberate version/profile/domain decision and new vectors. Every format change MUST update this directory, affected schemas and vectors in the same change, as required by [AGENTS.md](../AGENTS.md).

## 20. Security considerations

### 20.1. Untrusted archives and rendering

ZIP path traversal, duplicate names, contradictory Unicode names, declared-size bombs, malformed compression streams, unsafe attachments, and parser differentials must be handled before rendering or extraction. Current limits are application limits, not a cryptographic defense against every resource-exhaustion input. Applications SHOULD bound actual decoding work and memory use. No implementation should write archive names to the host filesystem without independent path containment checks.

HTML sanitization remains necessary after cryptographic verification: an authentic sender can still supply unsafe content. The static dependency recognizer is restricted and does not substitute for a full browser security policy. Event handlers, active content, external navigation, CSS fetching, fonts, and attachment opening need appropriate viewer controls. A signature verifies the source bytes and stated scope; it does not guarantee identical rendering, safe behavior, or truthful content.

### 20.2. JOSE and identity

Verifiers must enforce the expected algorithm/type, avoid attacker-directed key fetching, and use registry trust/authority independently of document claims. Key compromise, compromised application code, an XSS vulnerability, a stolen authenticated session, or misleading consent UI can defeat intended authorization even when ES256 remains sound. Public `kid` syntax does not establish trust. An email-session attestation must not be represented as personal private-key possession or independently verified legal identity.

Canonicalization and exact file-byte hashing avoid serializer differences within their specified data model. Implementations must not reserialize a JWS before signature verification or silently normalize signed paths/strings. Signature IDs and timestamps are not globally unforgeable ordering anchors. No low-S canonicalization requirement or JWS string-identity guarantee is introduced by this version; compare authenticated claims and bindings instead of treating ECDSA signature bytes as a unique transaction identity.

### 20.3. Partial deletion and rollback

Original signatures exclude runtime membership; form signatures cover one enumerated snapshot; seals cover the supplied logical snapshot. Those boundaries are intentional. Removing a wrapper can remove the only evidence that a signature existed. Removing later seals/history can expose an older valid state. An independently retained current archive, seal commitment, or other external reference is needed to detect rollback beyond this format's local evidence. The attestation journal is not an external document inventory or completeness oracle.

### 20.4. Local retention

There is no server document recovery. Exporting and retaining the resulting `.wdoc` is necessary to preserve signatures/nonces and signed snapshots. Nonces lost after a receipt is issued cannot be recovered from that receipt. The archive is not encrypted; recipients can read its contents, account labels, and local nonces. Transport and storage of the archive require the user's chosen confidentiality controls.

## 21. Privacy considerations

The protocol's privacy guarantee is data minimization at the platform signing boundary. Hashing, canonicalization, snapshot review, revision storage, archive verification, and ZIP assembly happen locally. Fresh random nonces prevent straightforward dictionary matching of predictable documents/answers from their commitments by a service that lacks the nonce. Nonces and raw file inventories MUST stay out of requests, telemetry, and error reports to that service.

The service still learns account identity, operation kind, request time, opaque commitments, and links between form/seal requests and a supplied original attestation. It stores receipts and a technical journal, as specified in the companion protocol. TLS, proxy/APM configuration, trusted frontend delivery, and avoiding accidental telemetry remain deployment responsibilities. This specification does not claim anonymity, protection against a compromised client, or confidentiality from someone who receives the archive.

The signing protocol has no document-upload or document-recovery route. The user's exchange channel, browser, and archive storage remain outside the attestation service's custody. Cloud storage, if introduced later, requires an explicit new profile and updated privacy specification.

## 22. Registrations and references

### 22.1. Registrations

This project specification creates no IANA registrations. `.wdoc` is the project's file extension. The three `wdoc-…+jws` values are project-defined JOSE type labels, not assertions of registered media types. Schema `$id` URLs are logical identifiers; publishing them as retrievable resources is a separate deployment task.

### 22.2. Normative references

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174): requirement terminology.
- [RFC 5234](https://www.rfc-editor.org/rfc/rfc5234): ABNF notation.
- [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259): JSON syntax.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785): JCS serialization.
- [RFC 4648, Section 5](https://www.rfc-editor.org/rfc/rfc4648#section-5): base64url alphabet.
- [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339): date-time model.
- [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515), [RFC 7517](https://www.rfc-editor.org/rfc/rfc7517), and [RFC 7518](https://www.rfc-editor.org/rfc/rfc7518): JWS, JWK, and ES256.
- [FIPS 180-4](https://doi.org/10.6028/NIST.FIPS.180-4): SHA-256.
- [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT): underlying ZIP records, as restricted by Section 4.
- [HTML Living Standard](https://html.spec.whatwg.org/multipage/): HTML parsing and browser form entry collection, as restricted by Section 5.
- [JSON Schema Draft-07](https://json-schema.org/draft-07/): structural schema vocabulary.

### 22.3. Informative references

[RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) provides the editorial model requested for this specification. wdoc payloads are not JWT claim sets. [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725) provides additional JOSE security guidance. The [operational guide](../docs/signatures/README.md) describes this repository's setup and use.

## 23. Test vectors

The [vector catalog](vectors/README.md) defines exact file encodings, canonical scopes, digests, commitment preimages, signed payloads, public test keys, and complete archive verification cases. Positive vectors include a document, form snapshot, seal, personal co-signature, and historical revision binding. Negative cases include modified bytes, missing files/nonces, invalid JSON, unsafe ZIP paths, unavailable/revoked keys, changed manifests, and altered commitments.

Test keys/nonces and example account labels are public test data. They MUST NOT be used in production. Vector manifests are intentionally minimal: optional editor metadata is unnecessary for interoperability. The vectors' expected outcomes are part of the current format's conformance baseline; changes require corresponding specification, schema, and implementation updates.
