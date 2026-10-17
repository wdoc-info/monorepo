# WDOC-ATTESTATION: commitment attestation protocol

Status: alpha project specification. Companion to [WDOC-FORMAT](wdoc-format.md), manifest `1.0`, commitment domains `v1`.

## 1. Purpose and requirement language

This document specifies the existing HTTP boundary between a local wdoc signing client and the platform attestation service. Uppercase requirement terms have the BCP 14 meanings established in [WDOC-FORMAT Section 1](wdoc-format.md#1-scope-and-conformance).

The service signs commitments requested by an authenticated account. It does not receive, parse, validate, store, host, or return the underlying document. Verification of original content, snapshots, revisions, and archive seals happens on the client or in an offline verifier. Authentication credentials and receipt metadata remain service data; the protocol does not promise anonymity.

The current interface has no protocol-version header or URL version segment. Its strict fields, `proofMode:"digest-only"`, and versioned commitment domains identify this profile. Adding fields or changing their meaning requires a specification and compatibility update.

## 2. Transport, encoding, and authentication

Production deployments MUST use HTTPS. HTTP is allowed only for local development loopback endpoints. Clients MUST use their configured service origin; document-controlled URLs MUST NOT select the attestation endpoint or registry. CORS is configured by the application and is not a substitute for authentication.

POST bodies MUST be valid UTF-8 JSON objects without a BOM sent with `Content-Type: application/json`. JSON duplicate names, invalid JSON, non-finite values, invalid Unicode, and nesting beyond 64 objects/arrays are rejected by the request parser. Members are case-sensitive. Invalid UTF-8, including replacement-decoding cases, returns `INVALID_REQUEST`. Unknown members MUST be rejected; accepting and ignoring content-bearing members would break the privacy contract.

The maximum request body is 16,384 bytes. `documentProof` is at most 8,192 string characters. Commitments have the 43-character unpadded base64url lexical form defined in the format specification. Request IDs have exactly this lexical syntax, with no URN prefix or braces:

```abnf
hex-digit    = DIGIT / %x41-46 / %x61-66
request-uuid = 8hex-digit "-" 4hex-digit "-" 4hex-digit "-"
               4hex-digit "-" 12hex-digit
```

The current request validator does not constrain the UUID version/variant bits. Clients MUST generate unpredictable UUIDs for distinct operations; the reference client uses lowercase random version-4 UUIDs. Request-ID storage and comparison preserve exact string case, so differently cased spellings are different idempotency keys. A bare archive ID need not be a UUID, but a protocol request ID must satisfy this syntax.

Every POST requires:

```http
Authorization: Bearer <session-token>
```

The service verifies the existing authentication JWT under HS256 using its configured authentication secret. It requires a nonempty `sub` and a string `email`, and enforces the JWT verifier's applicable time claims. `sub` becomes the signing actor's user ID and `email` the signed display name. This JWT is not an archive signature. The client MUST NOT send a signer, owner, user ID, email override, or evidence object in a signing body.

Existing `/login` and `/loginvalidate` provide email OTP authentication outside this document's scope. `consent:true` is a required assertion by the client after explicit local review. It does not prove that the platform displayed or saw the document, nor constitute a fresh transaction-bound OTP/passkey challenge.

Signing is limited to 30 admitted requests per authenticated user in the current in-memory limiter. At service time `t` in milliseconds, retain admitted timestamps greater than or equal to `t - 60,000`; admit and append `t` only if fewer than 30 remain. The lower boundary is inclusive. Failed validation and retries after authentication also consume admitted slots; denied requests do not append timestamps. The limiter resets with the process and is not shared across service instances. Clients MUST handle 429 without discarding the prepared local nonce or snapshot.

## 3. Allowed endpoints

Paths below are relative to the configured service base URL. Successful responses use HTTP 200 and JSON.

| Method and path | Authentication | Function |
| --- | --- | --- |
| `GET /signing-keys` | None | Retrieve public registry records and trust policy |
| `GET /info/<key-id>` | None | Retrieve a registered public EC P-256 JWK |
| `POST /signatures/document` | Bearer session | Attest an opaque original-document commitment |
| `POST /signatures/form` | Bearer session | Attest an opaque snapshot commitment linked to a trusted document proof |
| `POST /signatures/seal` | Bearer session | Attest an opaque full-archive commitment linked to a trusted document proof |

There is no document-upload, document-download, remote-verification, share-grant, or cloud-storage endpoint in this profile. `/documents/*` is not part of the implemented signing API. An implementation MUST NOT silently upload document bytes through another endpoint to complete these operations.

### 3.1. Public registry

`GET /signing-keys` returns:

```text
{keys: KeyRecord[]}
```

`KeyRecord` is defined in [WDOC-FORMAT Section 11](wdoc-format.md#11-jws-and-key-policy) and [the registry schema](schemas/key-registry.schema.json). This response contains no private JWK parameters. The server and offline CLI validate registry structure, public curve points, unique KIDs, key usage, and operator-approved origins. The browser applies the same validation with its own `backend.signingKeyOrigins` allow-list; a response cannot expand that policy. The current server constructs its registry from operator configuration; the client's trust in its configured server is an external policy decision. Merely copying `trusted:true` from an archive is not trusted enrollment.

`GET /info/<key-id>` returns the registered public JWK with `kid`, `alg:"ES256"`, and `use:"sig"`. The path is matched to configured registry records. Unknown keys return 404 `KEY_NOT_FOUND`. The returned JWK alone does not include all registry trust/authority/status policy. No response cache lifetime or automatic key-refresh interval is defined by this protocol. Keep historical retired public keys available for verification and distribute revocation policy separately.

### 3.2. Original attestation

`POST /signatures/document` accepts exactly:

```text
{
  requestId: UUID,
  consent: true,
  documentCommitment: digest
}
```

The client calculates `C("document", Digest(M), localNonce)` before sending. The service validates only the request shape, authentication/consent assertion, rate policy, and signing-key authorization. It cannot test whether the opaque string corresponds to a real, valid, or owned document.

### 3.3. Form attestation

`POST /signatures/form` accepts exactly:

```text
{
  requestId: UUID,
  consent: true,
  documentProof: compact-document-JWS,
  submissionCommitment: digest
}
```

The service verifies `documentProof` as a document JWS with `valid-trusted` key policy and `proofMode:"digest-only"`. It copies that proof's `documentCommitment` into the new form payload. It does not receive the document proof's local nonce, recompute the original digest, inspect answers, identify a form, or validate the submission. Proof payloads MUST match the one commitment-only signature profile.

The actor of the new form signature may differ from the actor named in `documentProof`. Possession of a proof is not a document access grant; there is no server document-ownership check. The client must separately verify the actual original and bind the snapshot before review/signing. File exchange between co-signers is outside this API.

### 3.4. Seal attestation

`POST /signatures/seal` accepts exactly:

```text
{
  requestId: UUID,
  consent: true,
  documentProof: compact-document-JWS,
  archiveCommitment: digest
}
```

The proof requirements are the same as for a form. The client has already frozen the complete file inventory and the actual manifest serialization. The service cannot test archive completeness or existing embedded signatures. These local requirements remain mandatory even though no inventory crosses the HTTP boundary.

## 4. Successful receipt and signed claims

All three POST endpoints return exactly:

```text
{signatureId: UUID, jws: compact-JWS}
```

`signatureId` is a random UUID generated by the service. The client validates the exact two-member receipt shape and UUID spelling before applying it. It is not a JWS claim and is not itself authenticated by that JWS. The client must enforce archive-local ID uniqueness before using it as a path or wrapper locator.

The service signs canonical UTF-8 JSON using ES256 and the kind-specific protected header. The exact payload member sets are specified in [WDOC-FORMAT Sections 13–15](wdoc-format.md#13-original-document-signatures) and the payload schemas. It derives:

| Claim | Source |
| --- | --- |
| `type` | Endpoint kind: `wdoc-document-signature`, `wdoc-form-signature`, or `wdoc-seal-signature` |
| `proofMode` | Constant `digest-only` |
| `documentCommitment` | Request for an original; verified original proof for a form/seal |
| `submissionCommitment` | Form request only |
| `archiveCommitment` | Seal request only |
| `mode` | `wdoc-attestation`, form only |
| `signer.userId` | Authenticated JWT subject |
| `signer.displayName` | Authenticated JWT email |
| `signedAt` | Service wall-clock UTC ISO date at issuance |
| `evidence` | `{method:"authenticated-session",consent:"wdoc-sign-v1",scope:"commitment-only"}` |

There is no `requestId`, filename, raw document digest, archive ID, form/submission ID, nonce, inventory, answer, or attachment in these payloads. Request correlation comes from the authenticated HTTP operation and idempotency store, not a signed request-ID claim.

Before applying the receipt, the client MUST cryptographically verify the JWS against its configured trusted key policy, expected kind, signer user ID, proof mode, and every locally prepared commitment. A successful HTTP status alone is insufficient. The nonce and local descriptor/files are committed atomically only after this verification.

## 5. Idempotency and retries

Idempotency is scoped by authenticated actor ID and request UUID across all three operation kinds. Let `input` be the parsed, validated complete request object. The service computes:

```text
fingerprint = H(UTF8(JCS({kind, input})))
```

An existing `(actor, requestId)` with the same fingerprint returns the identical stored receipt. Different valid input or operation kind with that pair returns HTTP 409 `IDEMPOTENCY_CONFLICT`. JSON member order and whitespace do not change the fingerprint after parsing. The exact `documentProof` JWS string does participate, so replacing it with a different but equivalent signature is a different input.

The server checks receipt existence before signing and rechecks inside the receipt/journal database transaction. Simultaneous identical requests may calculate more than one tentative JWS internally; only one receipt/event is committed and both responses return that stored receipt. A signing failure creates no receipt or event. A duplicate successful retry creates no additional event.

Authentication, rate policy, JSON validation, and form/seal proof verification occur before receipt replay. Therefore an expired session, exhausted rate limit, or now-revoked/invalid document proof can prevent a retry from reaching its stored receipt. A successful replay is not an exemption from current admission checks.

The client MUST retain the prepared local state, nonce, and UUID across an ambiguous network outcome. It MUST NOT generate a new nonce while retrying an existing commitment under the same UUID. Receipt storage does not preserve the private opening values needed to reconstruct a lost local document.

## 6. Service retention and technical journal

The current service stores the following signature data in SQLite, in addition to its existing authentication account/OTP state:

| Table | Columns and meaning |
| --- | --- |
| `signature_receipts` | `actor`, `request_id`, `fingerprint`, canonical receipt JSON; primary key `(actor, request_id)` |
| `signature_events` | Global autoincrement `sequence`, `actor`, canonical event JSON, event hash |

An event contains exactly:

```text
{
  requestId: UUID,
  kind: "document" | "form" | "seal",
  fingerprint: digest,
  signatureDigest: H(UTF8(JCS(receipt))),
  signedAt: date-time,
  previousHash: digest | null
}
```

The event hash is `H(UTF8(JCS(event)))`. `previousHash` is the previous stored event hash for this actor, or null for the actor's first event. The hash chain is per actor; `sequence` is a database ordering column outside the hashed event. Receipt/event insertion is transactional. SQLite triggers reject normal updates and deletes of journal rows.

The journal is technical tamper evidence under database controls, not an independently anchored transparency log. An administrator controlling the database, triggers, backups, and code can replace history. This journal contains no archive inventory and cannot prove that the latest file copy or seal has been retained. No retention duration, deletion API, journal-export API, or document recovery API is defined by this version.

Receipt payloads identify the account, time, operation, and opaque commitments. Form/seal receipts reuse the referenced original commitment and can be linked to that original attestation. The service MUST NOT store document bytes, metadata, file paths, answers, attachments, or local nonces in these tables. It stores the hash of the validated request, not the request body itself.

Application, proxy, APM, telemetry, and error handling MUST NOT log request bodies, bearer tokens, local state, nonces, or cryptographic/validation exception values that may contain submitted data. Infrastructure enforcement is a deployment responsibility. Removing old upload endpoints does not delete prior prototype databases, WAL files, logs, or backups; those require explicit retirement.

## 7. Errors

Known signing errors use JSON:

```text
{error:{code: string, message: string}}
```

Clients MUST branch on `code`/HTTP status rather than exact English message wording. An unmatched route may use the framework's ordinary non-JSON 404 response. There is no redirect-to-upload fallback.

| HTTP status | Code | Condition |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Malformed/ambiguous JSON, unknown fields, missing/invalid values, or consent other than `true` |
| 401 | `UNAUTHENTICATED` | Missing/invalid/expired bearer session |
| 403 | `DOCUMENT_NOT_TRUSTED` | Form/seal original proof is not a trusted commitment-mode document JWS |
| 404 | `KEY_NOT_FOUND` | No public key matching `/info/<key-id>` |
| 409 | `IDEMPOTENCY_CONFLICT` | Same actor/UUID reused with different validated input |
| 413 | `REQUEST_TOO_LARGE` | Body exceeds 16,384 bytes |
| 429 | `RATE_LIMITED` | Per-actor admission limit exhausted |
| 503 | `SIGNING_UNAVAILABLE` | No authorized active trusted platform signing key/private-key match |
| 500 | `SIGNATURE_ERROR` | Other operation failure, without sensitive error details |

Body-size middleware runs before signing authentication. Other errors are reported according to execution order; this table does not promise which error wins when several conditions are false. The current rate-limit response has no guaranteed `Retry-After` header.

## 8. Key configuration and fail-closed behavior

The service has no generated fallback production key. A new platform attestation requires an active, trusted platform registry record; an authorized current validity interval; a configured private EC P-256 JWK; and an exact public-coordinate match between that private key and the registry record. Otherwise issuance is unavailable.

When a private signing JWK is configured, the current application refuses its known development authentication secret or an authentication secret shorter than 32 characters. The private signing JWK is server-only and MUST NOT appear in the public registry, repository, logs, or client bundle. Separate authentication and document-signature keys are required by the implemented architecture.

Operator environment names, provisioning commands, file permissions, and routing setup are documented in [the operational guide](../docs/signatures/README.md). A specification baseline does not imply keys, DNS, TLS, or a deployment have been provisioned.

## 9. Personal signatures and future services

Personal form signing is local and is not an option on these three POST endpoints. The local client prepares a commitment payload with `mode:"personal"`, a registered personal KID/user ID, and commitment-only evidence. A selected local/hardware provider signs it; the client verifies the exact reviewed payload before inserting it. A personal signature does not require sending a local archive to this platform.

A future cloud-storage or stronger-authentication service MUST define its own data flow, authorization, retention, evidence, and compatibility changes explicitly. It MUST NOT be represented as implicit support in this protocol or silently relax the commitment-only request boundary.
