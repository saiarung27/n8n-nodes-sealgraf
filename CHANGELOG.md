# Changelog

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
