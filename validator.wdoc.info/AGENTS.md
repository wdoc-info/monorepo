# Agent guide: standalone validator

The root [AGENTS.md](../AGENTS.md) applies. Keep all authored code, UI, tests, and
prose in English. Read the [validator README](README.md) and relevant specification
sections before changing validation or trust behavior.

- Use standalone Angular components and OnPush change detection.
- Keep document processing in the worker. Never render/execute archive HTML or upload
  document bytes, metadata, hashes, nonces, or answers.
- Keep format validity, signature trust/failures, and optional improvements separate.
  An index-only ZIP is valid; a missing key is an unverified signature.
- Only the fixed configured public registry may be fetched. No KID-directed fetching,
  archive-provided key policy, credentials, account flow, or document persistence.
- `src/app/format/` and `public/spec/` are checked mirrors. Update the authoritative
  format/spec and run `npm run format:sync`; do not hand-edit copies.
- Run `npm test`, `npm run typecheck`, `npm run build`, and relevant `npm run e2e`
  workflows after implementation changes. The root workflow has path filters.
