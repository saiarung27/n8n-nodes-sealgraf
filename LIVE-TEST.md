# Sealgraf node for n8n — Live Test Record

**Date:** 2026-11-11 · **Verdict: PASS** — both spend loops completed live
against the real Sealgraf UAT service, driven through the built node's
`execute()`, and independently confirmed server-side. This closes the
"has not run against a live Sealgraf deployment" half of the mocked-scope
gap in BUILD-RECORD.md. (The "inside a live n8n instance" half remains
open — see Gaps below.)

**Harness:** `tests/live_harness.js` · **Run log:** `tests/live-run.log`
(one attempt, appended format).

## Environment

- Package: `n8n-nodes-sealgraf` 0.1.0, `dist/` rebuilt from the unchanged
  sources (`npm run build`, clean) immediately before the run. Node
  v24.22.1. No package source file was modified for this test; the only
  addition is the harness itself.
- Backend: Sealgraf UAT, `https://see-app-uat.onrender.com`, throwaway
  gate-1 test tenant. Live limits: ask above **$5.00**, per-purchase
  $150, 30-day $600 — so $3.00 allows instantly and $25.00 asks.
- Credentials reached the node exactly as production n8n would supply
  them: the harness context's `getCredentials('sealgrafApi')` returned
  `{ baseUrl: <UAT URL>, apiKey: <gate-1 agent key> }`, the key read
  from the gate-1 key file into memory only. It was never printed,
  logged, or copied; a post-run grep of the run log for the key returns
  zero occurrences. Decision tokens were captured in memory solely for
  the byte-identity assertions (assertions log token length only:
  43 chars in both loops).

## What was real vs substituted

| Layer | Status |
|---|---|
| Node `execute()` + per-operation runners (`dist/nodes/Sealgraf/Sealgraf.node.js`) | **Real** |
| `SealgrafClient` (request shapes, fail-closed parsers, evidence rules) | **Real** |
| Credentials type (`SealgrafApi`) | **Real class** — the harness helper reads its generic `authenticate` header template (`X-API-Key: ={{$credentials.apiKey}}`) from the built class and resolves the expression against the credential values, which is what n8n core does |
| `helpers.httpRequestWithAuthentication` | **Substituted host, real HTTPS** — a harness implementation of n8n core's contract: loads the credential for the type, applies the generic authenticate, serializes the body as JSON, appends `qs`, honors `timeout` (AbortSignal), and implements `returnFullResponse` + `ignoreHttpStatusErrors` semantics (HTTP statuses resolve as `{ statusCode, body }`; transport failures throw). Requests went over real HTTPS (Node fetch) to UAT. Every recorded wire call (8/8) shows the `X-API-Key` header applied from the credential |
| `IExecuteFunctions` context (`getInputData`, `getNodeParameter`, `getNode`, `getExecutionId`, `continueOnFail`) | **Substituted** — same shape as the mocked suite's context |
| HTTP + Sealgraf service (limits, approval, token escrow, sealing) | **Real** — live UAT tenant |
| Owner approval (loop B) | **Real, outside the node** — owner-session REST login → `POST /v1/preauthorize/{id}/approve`, mirroring the gate-1 script |
| Server-side confirmation | **Real** — owner-session GETs of both preauths and both receipts after the node runs |
| A booted n8n instance executing a workflow | **Not run** — the stretch goal; see Gaps |

## Loop A — instant allow ($3.00)

Single node, three `execute()` calls: check → complete → get receipt.

- Check (`n8n-live-allow-001`): outcome **allow**, state `authorized`,
  `replayed: false`, preauth
  `pa_a97be03f8f0849738d9369db6735bbb3`, token delivered (43 chars)
- Complete (`n8n-live-complete-001`): token in the complete parameters
  **byte-identical** to the token returned by the check (asserted in
  code) → sealed receipt `rcpt_d3b99b2014244998b950aad981c90de7`,
  **entry_seq 41**, amount_minor **300**
- Get Receipt (by preauth): state **completed**, receipt id matches
- Server-side (owner session): preauth state **completed**; receipt
  entry_seq 41, amount 300 USD, bound to the preauth. (The preauth view
  reports `was_allowed=false` on this instant-allow path vs `true` for
  the owner-approved loop B — the same server behaviour the CrewAI live
  test recorded; observed, not a node defect.)
- Wire: `POST /v1/preauthorize -> 201`, `POST .../complete -> 200`,
  `GET /v1/preauthorize/{id} -> 200`, credential header applied on all.

## Loop B — owner approval ($25.00)

- Check (`n8n-live-appr-001`): outcome **needs_human_approval**, state
  `pending_approval`, **no** `decision_token` in the output, preauth
  `pa_3479a70e7a7b4b8d9eec6e48a12d4379`
- Claim (once, pre-approval): refused — `NodeApiError` with
  `httpCode '409'` and message carrying `[code: not_approved_yet]`,
  exactly the surfacing the mocked suite pinned
- Owner approval (outside the node): preauth went
  `pending_approval` → **`authorized`** (approve HTTP 200)
- Claim (post-approval): succeeded, `claimed: true`, token delivered
  (43 chars)
- Complete (`n8n-live-complete-002`): token **byte-identical** to the
  claimed token (asserted in code) → sealed receipt
  `rcpt_47904a72ddcb4cdb886c957be81180f9`, **entry_seq 44**,
  amount_minor **2500**
- Get Receipt (by preauth): state **completed**, receipt id matches
- Server-side (owner session): preauth state **completed**,
  `was_allowed=true`; receipt entry_seq 44, amount 2500 USD, bound to
  the preauth.
- Wire: check `201`, pre-approval claim `409`, post-approval claim
  `200`, complete `200`, get `200`, credential header applied on all.

## Attempts

1. **Attempt 1** (2026-11-11 20:32 UTC): full pass. Credential
   pre-flight (`GET /v1/receipts?limit=1` → 200, harness-side, mirroring
   the credential type's test request), both loops, and both
   server-side confirmations — every assertion green on the first run.
   No retries were needed and nothing failed on the way, so there are
   no failed attempts to preserve.

## Friction / findings

- **No package friction and no defects found.** The node behaved
  identically live and mocked: request shapes, the replay/pending
  output shapes, the refusal-code surfacing (`httpCode` + `[code: ...]`
  in the `NodeApiError` message), and fail-closed conversions all
  matched the mocked suite's pinned expectations against the real
  service.
- The generic-authenticate contract proved to be exactly reproducible
  outside n8n core: reading the header template from the built
  credentials class and resolving `={{$credentials.apiKey}}` produced
  the header the service accepted on all 8 wire calls.

## Gaps — remaining

- **A real n8n instance run is still unproven.** The stretch goal was
  not attempted: no `n8n` binary exists in this environment (only the
  `@n8n/node-cli` build tooling), and installing n8n is a heavy,
  slow download that the test brief explicitly said not to burn the
  run on. Everything n8n core would do for this node — credential
  loading, generic-authenticate application, the authenticated
  request helper — was reproduced contract-faithfully and exercised
  for real; what remains unproven is only the editor/execution-host
  shell around it (workflow expressions, Wait-node resume, the GUI
  credential test button).

## Bottom line

The live half of the BUILD-RECORD gap is closed: the built node's real
`execute()` ran both Sealgraf spend loops end to end against the live
service through its own credentials type, the approval gate held
pre-approval with the production refusal code intact, tokens moved
byte-identically from check/claim into completion untouched, and both
receipts (entry_seq 41 and 44) are sealed server-side with the right
amounts.
