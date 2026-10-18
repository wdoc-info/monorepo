# wdoc specification

This directory is the normative specification of the currently implemented wdoc document format. It defines the bytes, structures, algorithms, validation rules, and privacy boundaries needed for an independent implementation.

wdoc is in the alpha ideation phase. All design decisions are provisional, and this specification evolves with accepted ideas, experiments, and implementation changes. Its current requirements define conformance for the current implementation; they are not a reason to reject a proposed design change. Update the specification, schemas, vectors, and implementation together as the design evolves.

| Item | Value |
| --- | --- |
| Specification identifier | WDOC-FORMAT |
| Current manifest version | `0.1` |
| Current signature profile | `proofMode: "digest-only"` |
| Commitment domain version | `v1` |
| Status | Alpha project specification; not an IETF RFC or an Internet Standard |

This specification defines one current alpha format without historical profiles or migration procedures. A ZIP containing only `index.html` is valid and unsigned. A single enclosing folder is also supported under the deterministic root rules in Section 4.4. A manifest and signature material are optional; when present they follow the complete current profile. Optional embedded Git history is defined in Section 20. Documents stay local; the signing service receives only randomized commitments.

Start with [WDOC-FORMAT](wdoc-format.md). The companion [WDOC-ATTESTATION](attestation-protocol.md) specifies the existing commitment attestation protocol. The [schema catalog](schemas/README.md) contains JSON Schema Draft-07 definitions; [test vectors](vectors/README.md) supply exact bytes, intermediate values, complete JWS examples, and expected verification results. [Implementation notes](implementation-notes.md) map the specification to the code, enforced checks, and intentional scope boundaries.

The numbered requirements in the format and protocol documents are authoritative. Schemas describe structural constraints; they cannot establish cryptographic validity, path-to-ID relationships, trust, or archive completeness. Examples are informative unless explicitly identified as test vectors. Implementation notes distinguish enforced checks from intentional format boundaries. A discrepancy must be resolved by changing the specification and implementation together, not by silently treating a permissive parser as a new format definition.

Operational setup, key provisioning, CLI commands, and deployment responsibilities remain in [the signature guide](../docs/signatures/README.md). The repository language and mandatory specification maintenance rules are in [AGENTS.md](../AGENTS.md).
