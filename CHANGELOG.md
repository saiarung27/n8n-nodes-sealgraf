# Changelog

## 0.1.2 — 2026-11-12

- Verification fix: the node's transport now throws n8n-native
  NodeOperationError directly, and the shared client passes n8n-native
  errors through unchanged — satisfying n8n's community-node error rules
  without eslint disables. Error messages and fail-closed behavior are
  unchanged. (0.1.1 failed n8n's package scanner on this rule.)
- User-Agent version literal now matches the package version.

## 0.1.1 — 2026-11-12

- Re-release of 0.1.0 published from GitHub Actions with an npm provenance
  statement, as required for n8n verified community nodes since 2026-05-01.
  No functional changes.

## 0.1.0 — 2026-11-11

- Initial release (built locally; not yet published).
- `Sealgraf` node with four operations: Check Permission, Claim Decision
  Token, Complete Purchase, Get Receipt.
- `Sealgraf API` credentials type (agent API key as `X-API-Key` header,
  credential test via `GET /v1/receipts?limit=1`).
