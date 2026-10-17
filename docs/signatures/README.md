# Private signatures for local wdoc documents

The normative format and protocol are defined in [`spec/`](../../spec/README.md),
with [JSON schemas](../../spec/schemas/README.md) and
[executable test vectors](../../spec/vectors/README.md). This guide covers operation
and deployment; format definitions are maintained in that specification.

The `.wdoc` document stays on the user's device. Hashing, manifest handling, immutable answers, attachments, content revisions, final seals, file verification and ZIP assembly run locally. The signature backend never receives an archive, manifest, title, file name, document ID, form ID, answers, attachments or the local random nonces. Cloud storage is deferred.

The backend receives **randomized commitments**, verifies the authenticated session and any supplied document attestation, and signs those commitments. It cannot inspect or validate the underlying files. A successful signature means the authenticated account requested that attestation; the verifier must also check the actual document locally. The interface distinguishes these guarantees.

## Data sent to the backend

All signing requests are authenticated with the existing OTP-session bearer token. Public key lookup remains anonymous. These are the only signing endpoints:

| Route | Strict JSON body |
| --- | --- |
| `POST /signatures/document` | `{requestId, consent:true, documentCommitment}` |
| `POST /signatures/form` | `{requestId, consent:true, documentProof, submissionCommitment}` |
| `POST /signatures/seal` | `{requestId, consent:true, documentProof, archiveCommitment}` |
| `GET /signing-keys` | Returns public keys and their operator-managed trust policy |
| `GET /info/{keyId}` | Returns a public ES256 JWK |

`documentProof` is an existing compact JWS from the private document-signing endpoint. Its payload contains commitments and account attestation metadata. It contains no document metadata or local nonce. The backend verifies its type, signature, key status and trust policy. A form/seal request for an unverifiable document proof is rejected. All extra request fields are rejected, including `files`, `manifest`, `answers`, `attachments`, `nonce`, names and titles. Requests are limited to 16 KiB, and signing to 30 requests per authenticated user per minute.

Opening, verifying, revising, co-signing and exporting operate locally. Signing and public-key lookup require network access; the separate CLI verifies with an independently supplied registry without contacting a server. The signing API has no archive upload, storage, remote verification, sharing, or retrieval endpoint.

## What the backend retains

`signature_receipts` stores the account ID, request UUID, SHA-256 of the validated request and the generated signature receipt. This supports identical retries without issuing duplicate signatures. `signature_events` is a hash-chained append-only technical journal containing request IDs, operation kinds, fingerprints, signature hashes and dates, associated with the signing account. The server also retains the existing authentication accounts/OTP state.

These tables contain no files, document content, file paths, original metadata, answers, attachments or local nonces. Signed receipts identify the account (`userId`/account email), signature date, operation and randomized commitments. They reveal that an account requested a signature and when; form/seal proofs can be linked to the referenced opaque document attestation. This is intentionally not a document-storage service.

Request bodies and cryptographic/validation error values must not be logged by application, reverse proxy, APM or infrastructure middleware. The application does not log those values. Infrastructure logging configuration remains a deployment responsibility.

## Commitments and signed scope

Original document integrity uses manifest 1.0:

```text
documentDigest = base64url(SHA256(UTF8(JCS({manifestVersion, meta, content}))))
```

`content.files` contains the unpadded base64url SHA-256 of every original file's actual bytes. `meta` and every `content` property are protected. `runtime` and `signatures` are excluded, so submissions and additional signatures do not alter the original document's digest. Matching untrusted hashes alone do not authenticate an identity.

A new 32-byte cryptographically random nonce is generated locally for each signature:

```text
commitment(kind, value, nonce) =
  base64url(SHA256(UTF8(JCS({
    domain: "wdoc-" + kind + "-commitment-v1",
    nonce,
    value
  }))))
```

The nonce is **never sent** to the backend. This prevents the backend from learning file names or testing predictable answers by hashing candidate files against an exposed per-file hash. It is retained inside the local archive so a recipient can independently recalculate the commitment. This is a salted commitment protocol, not a claim of a formal zero-knowledge proof or verification of plaintext by the server.

### Original document

`value` is `documentDigest`. The server returns a compact ES256 JWS with:

```json
{
  "type": "wdoc-document-signature",
  "proofMode": "digest-only",
  "documentCommitment": "<43-character commitment>",
  "signer": {"userId": "<authenticated account>", "displayName": "<account email>"},
  "signedAt": "<declared server time>",
  "evidence": {"method": "authenticated-session", "consent": "wdoc-sign-v1", "scope": "commitment-only"}
}
```

The local signature wrapper is `{signatureId,jws,nonce}` in `signatures.document`. Changing that local nonce or the protected content breaks verification of the commitment. The server does not verify authorship, ownership or the document's semantic validity.

### Form snapshots

The browser freezes answers in `submissions/{uuid}/answers.json` and copies attachments under the same immutable submission directory. The form commitment's `value` is:

```text
{docId, documentDigest, formId, submissionId,
 files: {answersPath: sha256Bytes, attachmentPath: sha256Bytes, ...}}
```

Only its randomized `submissionCommitment` and the original document proof are sent. The JWS has `type: "wdoc-form-signature"`, `proofMode: "digest-only"`, `mode: "wdoc-attestation"`, `documentCommitment`, `submissionCommitment`, authenticated signer, date and commitment-only evidence. The local wrapper additionally contains `formId`, `submissionId` and the nonce. Verification recomputes the exact local snapshot and confirms its relationship to a verified original or historical content revision.

Fields with repeated names are ordered arrays, unchecked groups are explicit, and the consent view presents frozen answers and downloadable attachment bytes/hashes. Changing the draft does not edit a signed snapshot. A correction creates a new submission with `replaces`. Co-signing uses an existing immutable `submissionId` and its unchanged files; each signer has a separate randomized commitment to those same bytes. The backend never receives the form ID or snapshot ID.

### Final seal

The seal's `value` is `{docId,files:inventoryOfEveryArchiveFileExceptThisSealPair}`. The inventory includes **actual `manifest.json` bytes**, original files, all submission files, historical content and every previous seal/nonce file. It is hashed locally. Only `archiveCommitment` plus the original document proof is sent. The seal payload has `type: "wdoc-seal-signature"`, `proofMode: "digest-only"`, `documentCommitment`, `archiveCommitment`, signer/date and commitment-only evidence.

The compact JWS is saved in `seals/{signatureId}.jws`; the local nonce is in `seals/{signatureId}.nonce`. Both are excluded from their own committed inventory, avoiding recursion. Changing or deleting the nonce invalidates the seal. A later addition or signature requires a new seal and leaves previous document/form signatures intact. Earlier seals report `archive-changed` after an archive change.

A seal proves integrity of the supplied archive snapshot. Without an external retained reference it cannot prove that a later signed snapshot or last seal was not discarded, nor prevent rollback to an older valid archive. The minimal backend journal does not possess a complete inventory or serve as a cloud history of the document. Preserve and exchange the latest `.wdoc` deliberately.

## Local workflow and atomicity

1. Open a local `.wdoc` or create/export one in the editor. A ZIP containing only `index.html` is valid and unsigned. One enclosing folder is accepted when it contains its index immediately and has no sibling root entries. A fresh complete manifest is prepared locally for signing; a present malformed manifest is rejected.
2. Log in, expand **Signatures**, and sign the original. Only a commitment leaves the browser.
3. Fill a form and review the frozen JSON and attachments. Explicit consent is required. The browser requests a commitment attestation and locally adds the snapshot, signature and nonce together.
4. Download and keep the archive. No server copy can be recovered if that local file is lost.
5. To co-sign, exchange the `.wdoc` through a channel you choose. The recipient opens it, verifies locally, reviews the immutable answers and signs the same snapshot. No email-based access grant or server-hosted document is involved.
6. To revise original content, use **Save as new signed content revision**. The browser archives old originals under `revisions/{oldDigest}/files/{originalPath}`, keeps protected scopes and signatures in `runtime.revisions`, and signs the new scope. Old forms remain bound to the old revision.
7. Optionally seal the whole archive, then download it again.

Every operation prepares a cloned local state, validates it and calculates commitments before requesting a JWS. The response is cryptographically verified and compared with the requested commitments and signer before applying it. A network/server/verification failure leaves the source document unchanged. Retrying an unchanged operation reuses its request ID, frozen snapshot and local nonce. Concurrent operations in one browser service are rejected. Backend receipt/journal writes are transactional, including simultaneous identical request deduplication. Different data under an already used request ID returns 409.

There is no global server version counter or document ownership database. Independent edits to copies on different devices produce branches. Merge/distribution of those local copies is a file workflow; future cloud storage may add coordination explicitly. Switching documents while a request is outstanding does not apply the old result to the new document.

## Personal signatures

The normal UI uses wdoc attestation of an authenticated request for a **commitment**, with all file checks local. Email OTP login is not presented as a personal private key or as a fresh transaction OTP/passkey challenge. Signed dates are claims, not independent trusted timestamps.

`WdocSignatureService.preparePersonal(state, formId, input, kid)` supports an independently enrolled personal key. It prepares the immutable snapshot and a personal JWS payload **locally**, using the same commitments, `mode: "personal"`, the registry-bound identity and `evidence: {scope:"commitment-only"}`. A local/hardware signing provider signs that payload. `completePersonal(request,jws)` verifies the exact payload, registered key and identity before adding the result locally. Neither method posts a snapshot or signature request to the platform. Do not transmit the `prepared` local-state object to a remote provider; only the commitment payload belongs at the signing boundary.

Key creation, private-key custody and identity proofing belong to the selected personal provider and operator-approved enrollment process. The default UI does not enroll keys or integrate a hardware provider. A future stronger OTP/passkey confirmation should bind its challenge to the reviewed commitment and be server-verified before adding such evidence; no such stronger proof is claimed today.

## Keys, trust and provisioning

The same JCS/JOSE verification core is mirrored in frontend/backend, with parity enforced in tests. Nonces, known SHA-256/JCS vectors, original bytes, submissions, historical revisions and whole-archive commitments are verified locally. The CLI never sends the archive to a server. Cryptography uses `jose` and Web Crypto, with explicit ES256/type checks and a controlled registry. No JWS causes arbitrary KID URL fetching. JSON duplicate keys, non-finite numbers and invalid Unicode are rejected.

The key registry contains `{kid,jwk,status,trusted,authority,owner,userId?,notBefore?,expiresAt?}`. Public EC P-256 keys only; active platform private keys stay on the server. Retired public keys remain available after rotation. Revoked, expired or unauthorized keys are rejected. A mathematically valid signature with `trusted:false` does not authenticate the signer identity. A declared date cannot override current revocation/expiry policy.

Signing remains disabled until an operator provisions a key. Inside `backend.wdoc.info`:

```sh
bun run keys:generate ./data/signing https://sig.wdoc.info/info/unique-key-version
```

This writes a private JWK with mode 0600 and a public registry; it refuses to overwrite files. Configure through a secret manager/environment:

| Variable | Value |
| --- | --- |
| `JWT_SECRET` | A random authentication secret of at least 32 characters; the known development default is rejected when signing is configured |
| `SIGNING_KID` | Active platform key URL |
| `SIGNING_PRIVATE_JWK` | Server-only private JWK JSON |
| `SIGNING_PUBLIC_KEYS` | Public registry key array including historical and enrolled personal keys |
| `SIGNING_KEY_ORIGINS` | Exact allowed HTTPS origins, comma-separated |

The default key origin is `https://sig.wdoc.info`. Provision DNS, TLS and routing of `/info/{keyId}` before production; infrastructure is not deployed by this change. The browser only loads key policy from its configured backend origin. Offline verification uses an independently trusted registry. Do not publish private keys or log authentication bearer tokens.

The browser independently checks key-record structure, public curve points,
unique KIDs, usage and origins. Configure `backend.signingKeyOrigins` in both
`app.config.ts` and `app.config.production.ts` when enrolling another provider;
the default list contains only `https://sig.wdoc.info`. A response cannot add
origins to this policy. Invalid/unavailable responses clear usable online keys.

## Formats and validation

The [normative JSON schemas](../../spec/schemas/README.md) describe the optional complete manifest 1.0, required local nonce wrappers, and one commitment-only decoded JWS profile. A locally verified original attestation is required for form/seal requests. The format has no historical profiles or migration paths.

A document needs only a UTF-8 `index.html`, either at ZIP root or immediately inside one enclosing folder. With a root index, multiple resource/runtime folders are allowed. Without one, multiple root folders (including empty or OS-metadata folders), sibling root files, extra wrapper depth, and case-insensitive index searches are rejected. All readers resolve identical logical paths; repacking under one wrapper does not change signed bytes, digests, or seals. Exports use root-level document paths.

Readers reject unknown/missing manifest versions, duplicate IDs or protected-header names, invalid dates, noncanonical encodings, and inconsistent ZIP headers. Display, signing, draft saves and CLI verification share bounded decoding and CRC/actual-size checks. A missing manifest is valid unsigned input; an invalid present manifest is never replaced. The offline CLI returns a null document digest for manifestless input. Its zero exit code allows a valid unsigned archive and is not itself a claim of identity or completeness; inspect the report's separate checks.

The self-contained static HTML/CSS signing profile remains enforced **locally**: original rendering resources must belong to protected original files or supported data URLs, not mutable runtime paths. Active HTML/SVG, external rendering dependencies, ambiguous CSS escapes and `srcset` must be flattened first; the existing zero-width-space typographic escape is supported. DOMPurify and Shadow DOM stay in place. This is an integrity/signing profile, not a server inspection guarantee.

ZIPs reject traversal, duplicate paths, encryption, ambiguous Unicode overrides and ZIP64. Limits remain 1,000 directory entries, 10 MB per uncompressed file and 30 MB expanded archive. New form attachments cannot be executable HTML/JS/SVG/scripts. These limits apply locally before any signing request; files are never split into requests to the backend.

## Verification and tests

```sh
cd backend.wdoc.info
bun test
bun run typecheck
bun run verify:wdoc /absolute/path/document.wdoc /absolute/path/trusted-registry.json

cd ../app.wdoc.info
npm test -- --watch=false --browsers=ChromeHeadlessNoSandbox --code-coverage
npm run build -- --configuration=production
npm run e2e -- e2e/wdoc.signatures.spec.ts
```

The offline registry format is `{keys:[...],allowedOrigins:["https://sig.wdoc.info"]}`. Verification reports separate original/form/revision/seal results: trusted, untrusted identity, modified/missing files, invalid JWS, unavailable/revoked keys, wrong revision, unsigned data and obsolete seals. It never infers a global “valid” from a partial check. No seal means completeness has not been established.

Tests inspect HTTP request bodies, decoded JWS claims and persisted database rows to ensure document content, names, identifiers and nonces do not leave the browser. The Chromium integration test uses a real ephemeral commitment backend, signs and downloads an archive, co-signs an exchanged file in a second account/browser, seals locally and preserves history through a signed revision.

Standards: [JCS RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), [JWS RFC 7515](https://www.rfc-editor.org/rfc/rfc7515), [JWK RFC 7517](https://www.rfc-editor.org/rfc/rfc7517), [JWA RFC 7518](https://www.rfc-editor.org/rfc/rfc7518), [JOSE/JWT security RFC 8725](https://www.rfc-editor.org/rfc/rfc8725).
