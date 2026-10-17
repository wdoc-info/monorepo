# JSON schema catalog

These JSON Schema Draft-07 documents define the structural reader/producer profiles in [WDOC-FORMAT](../wdoc-format.md) and [WDOC-ATTESTATION](../attestation-protocol.md). They are the single maintained schema set; deployment instructions in `docs/` refer here.

| File | Validated value |
| --- | --- |
| [common.schema.json](common.schema.json) | Shared primitive, path, scope, wrapper, submission, and revision definitions |
| [manifest.schema.json](manifest.schema.json) | Complete manifest `1.0`, when the optional manifest file is present |
| [protected-header.schema.json](protected-header.schema.json) | Decoded producer JOSE protected header |
| [document-jws.schema.json](document-jws.schema.json) | Decoded commitment-only document JWS payload |
| [form-jws.schema.json](form-jws.schema.json) | Decoded form JWS payload, including personal/platform mode constraints |
| [seal-jws.schema.json](seal-jws.schema.json) | Decoded seal JWS payload |
| [key-registry.schema.json](key-registry.schema.json) | Public key registry response or offline input; offline use additionally requires `allowedOrigins` |
| [attestation-request.schema.json](attestation-request.schema.json) | Strict request bodies; `oneOf[0]` is document, `[1]` form, `[2]` seal |
| [receipt.schema.json](receipt.schema.json) | Successful HTTP receipt |
| [answers-html.schema.json](answers-html.schema.json) | Standard HTML form collection profile; not every lower-level JSON answer value |
| [draft-section.schema.json](draft-section.schema.json) | Editable draft inventory: SHA-256/base64url file map |

A manifestless document does not require JSON Schema validation: validate its ZIP, logical root, paths, limits, and UTF-8 entry point directly. JSON schemas describe optional features when present.

Load all schemas into an offline resolver by their `$id` before validation. The IDs retain the project's `https://www.wdoc.info/schemas/` namespace; they are identifiers, not a promise that those URLs are currently served. No network fetch is needed. Enable `date-time`, `uri`, and `uuid` format validation.

For a request, validate the branch selected by the actual endpoint, not just the union: a seal-shaped body is invalid on `/signatures/form` even though it is a valid member of the request union. For JWS, validate decoded JSON only after or alongside the required cryptographic verification; successful schema validation is not successful signature verification.

Additional semantic requirements include exact original/snapshot/archive membership, UTF-16 path length, case-sensitive path identity, ID/path relationships, global ID uniqueness, digest-derived revision locations, required nonce openings for wrappers/seals, valid curve points, exact KID origin/authority policy, and authenticated commitment bindings. JSON Schema cannot enforce these cross-document and byte-level rules. Every signature wrapper requires `nonce`; there is one commitment-only payload shape for each kind.

Manifest JSON parsing must reject duplicate names before a validator sees the object. Schema `maxLength` counts Unicode code points, whereas the path implementation counts UTF-16 code units; the prose's 512-unit limit still applies. Date schemas combine `date-time` with the supported strict clock/offset syntax and exclude leap-second spelling. Readers also check real calendar dates and finite conversion; new writers emit the narrower UTC millisecond spelling. Hash and nonce patterns require canonical final bits and absolute string termination, including rejecting a final line break.

Run [the vector validator](../vectors/README.md) to compile every schema, validate the published positive values, and exercise selected structural rejection cases. The reference application enforces equivalent structure through its mirrored `validation.ts` module rather than compiling these schemas at runtime. Cross-reference and byte-level checks are described in [implementation notes](../implementation-notes.md).
