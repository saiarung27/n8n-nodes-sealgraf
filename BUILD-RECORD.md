# n8n-nodes-sealgraf — Build Record

**Date:** 2026-11-11 · **Status: BUILT AND TESTED LOCALLY. Nothing
published, submitted, or uploaded anywhere** — no npm release, no
GitHub repo created, no Creator Portal submission. Those are the
founder-gated steps listed in
`~/workspace/see-plan/tier-a-option4-plan-20261111.md` §1 and remain
untaken (see Gaps).

## What was built

An npm package `n8n-nodes-sealgraf` 0.1.0 (MIT) containing ONE
programmatic node, **Sealgraf**, exposing Sealgraf's four REST
operations behind an Operation dropdown, plus the **Sealgraf API**
credentials type that sends the agent API key as the `X-API-Key`
header. Scaffolded with the official `n8n-node` CLI
(`@n8n/node-cli` 0.56.2, `n8n-node new --template
programmatic/example`), then the example node was replaced wholesale.

```
n8n-sealgraf/
├── package.json              # zero runtime dependencies; n8n key declares node + credentials
├── README.md                 # usage, spend-loop example workflow, authentication, errors
├── CHANGELOG.md
├── credentials/
│   └── SealgrafApi.credentials.ts   # baseUrl (default https://sealgraf.com) + apiKey;
│                                    # generic authenticate -> X-API-Key header;
│                                    # test = GET /v1/receipts?limit=1
├── nodes/Sealgraf/
│   ├── Sealgraf.node.ts      # description (Operation dropdown, displayOptions per op,
│   │                         # evidence collection) + execute() + per-operation runners
│   ├── SealgrafClient.ts     # framework-free TypeScript port of the reference client:
│   │                         # request/status handling, five response parsers, validators,
│   │                         # buildEvidence — no n8n imports, transport injected
│   ├── Sealgraf.node.json    # codex (categories: ["Finance & Accounting"])
│   └── sealgraf.svg          # the locked brand icon (same file as the Dify plugin's
│                             # _assets/icon.svg, the brand master)
└── tests/
    ├── sealgraf.test.js      # node:test suite driving execute() with stubbed helpers
    ├── test-run.log          # npm test (build + suite): 34 passed / 0 failed
    ├── lint-run.log          # npm run lint (n8n-node lint): exit 0
    ├── load-check.log        # dist load + description/credential introspection
    └── scan-run.log          # @n8n/scan-community-package attempt (see Gaps)
```

## Design decisions, each deliberate

- **Programmatic, not declarative.** Declarative routing cannot
  express this contract: closed-vocabulary evidence assembly with
  cross-field rules enforced *before* any HTTP call, fail-closed
  response parsers, and the idempotent-replay rule. (The scaffold's
  own `.agents` docs ask for this justification.)
- **One shared client port.** `SealgrafClient.ts` mirrors the verified
  reference client (`dify-sealgraf-plugin/plugin/sealgraf_client.py`)
  semantics exactly — same request shapes, same parsers, same parsed
  output shapes, same error taxonomy (`SealgrafError` /
  `SealgrafApiError` with status, detail, and the server's stable
  `code`) — so all Sealgraf surfaces (Dify, Composio, LangChain,
  CrewAI, n8n) behave identically. Evidence keys and payment
  vocabularies were re-verified against production `origin/main`
  `see/service.py` (`_SEALED_EVIDENCE_KEYS`, `_PAYMENT_RAILS`,
  `_RAIL_REF_KINDS`, `_PAYMENT_PROVENANCES`) and category ids/labels
  against `see/notify.py` `_CATEGORY_LABELS`.
- **Get Receipt follows the reference, not the one-line summary.**
  The task summary described this operation as
  `GET /v1/receipts?preauth_id={id}`. Production has no such filter —
  `origin/main` `see/api.py` `list_receipts` accepts only `limit` and
  `cursor`, so that URL would silently return unrelated receipts.
  Like every sibling surface, the node takes exactly one of a
  preauthorization ID (`GET /v1/preauthorize/{id}`) or a receipt ID
  (`GET /v1/receipts/{id}`), validated before any HTTP call.
- **HTTP via the credentials type.** All calls go through
  `this.helpers.httpRequestWithAuthentication`, so the credential's
  generic `authenticate` applies the `X-API-Key` header — the
  credential type is exercised, not bypassed. Status handling mirrors
  the reference client (`returnFullResponse` +
  `ignoreHttpStatusErrors`, then the client applies the status rules),
  which is what lets refusal codes survive intact.
- **Errors are n8n errors.** In `execute()`, `SealgrafApiError` is
  converted to `NodeApiError` (with `httpCode` and the full client
  message, refusal code included, as the message) and `SealgrafError`
  to `NodeOperationError`; local parameter validation in the
  per-operation runners throws `NodeOperationError` directly.
  `continueOnFail()` is honored with an `error` output item.
- **Completion nonce.** A user-supplied nonce wins; otherwise the node
  generates `n8n-<executionId>-<preauthId>` — stable within one
  workflow execution (a node re-run re-sends the same completion),
  distinct across executions, and derived without touching the
  environment or filesystem.
- **Timeouts.** The reference client's connect/read split (5s/20s)
  maps onto the helper's single `timeout`, set to 20000 ms. Timeout
  and network failures become fail-closed errors; they can never
  produce a permission output.
- **Zero runtime dependencies**, no environment-variable or
  filesystem access anywhere in `nodes/` or `credentials/` (grep
  verified); `n8n-workflow` is a peer dependency only.

## How n8n idioms were verified (installed typings, not memory)

Installed: `n8n-workflow` **2.47.1**, `@n8n/node-cli` 0.56.2,
TypeScript 5.9.2, Node 24.22.1.

- `helpers.httpRequestWithAuthentication(credentialsType,
  requestOptions)` — signature read in
  `node_modules/n8n-workflow/dist/cjs/interfaces.d.ts` (line 745);
  `IHttpRequestOptions` provides `returnFullResponse`,
  `ignoreHttpStatusErrors`, `timeout`, `qs`, `json`.
- **`NodeApiError` in 2.x takes the API error body object
  (`JsonObject`), not an Error instance** — read in
  `errors/node-api.error.d.ts`. This differs from older n8n examples;
  the client therefore keeps the raw error body (`responseBody`) and
  `execute()` passes `{ ...body, message }` (NodeApiError prefers
  `message` over `detail`, and the client message carries the refusal
  code). Probed live against dist before the suite was written: the
  resulting error has `httpCode: '409'` and the message
  `Sealgraf API error (HTTP 409): ... [code: not_approved_yet]`.
- Credentials: `IAuthenticateGeneric` and `ICredentialTestRequest`
  confirmed in the same typings; credential test uses
  `GET /v1/receipts?limit=1` (the mandates endpoint is admin-gated in
  production and refuses agent keys).
- The official linter (`n8n-node lint`, `@n8n/node-cli` 0.56.2,
  runs offline) drove several code changes, all recorded here:
  codex category `"Finance & Accounting"` (from the rule's allowed
  set); evidence collection options alphabetized by display name;
  credential `icon` added; node + credential icons in themed
  `{ light, dark }` form (both point at the single locked brand
  master — the brand asset is not redrawn per theme); package
  `author` gained the project's public support email
  (support@sealgraf.com); duplicate `n8n-workflow` imports merged.
- **Lint exceptions (2 sites, justified in-line):** the transport
  closure inside `execute()` and the rethrow/wrap inside the client's
  `request()` keep throwing the shared client's domain errors
  (`require-node-api-error` / `node-execute-block-wrong-error-thrown`
  disabled per-line). The static rule cannot see that `execute()`
  converts every `SealgrafError` into a `NodeOperationError` /
  `NodeApiError` before it can escape; keeping the client's taxonomy
  identical across all five Sealgraf surfaces is worth more than
  satisfying the static check at the cost of a divergent fork. All
  other lint findings were fixed in code. Final lint: **exit 0**.

## Proof

- `npm run build` (`n8n-node build` / tsc strict): **clean**.
  `npm pack --dry-run`: 14 files, dist-only payload as declared.
- **Load check** (`tests/load-check.log`): dist node + credentials
  required and instantiated — node `sealgraf`, the four operations,
  required `sealgrafApi` credential, authenticate header mapping, and
  the credential test request all as designed.
- **Tests** (`tests/test-run.log`): **34 passed / 0 failed**
  (`node:test`, run against the built dist). The suite drives the
  node's real `execute()` with a stubbed `IExecuteFunctions` whose
  `httpRequestWithAuthentication` records requests and applies the
  credential header the way n8n core does. Coverage: exact request
  shapes for all four operations (method, URL, `X-API-Key` header,
  the action-nested check body, the `{}` claim body, bodyless GETs);
  allow / deny / needs_human_approval parsing; the replay rule
  (replayed allow → `decision_token_redelivered: false`, no token)
  and its counterpart (fresh tokenless allow → fail closed); all
  seven production claim-refusal codes surfacing intact with their
  HTTP status; the full evidence object asserted over the wire and
  every cross-field rule rejected *before* any HTTP call; generated
  completion nonce; 401 / timeout / network / non-JSON failures all
  failing closed; `continueOnFail` error items; a full
  check → claim → complete loop with the claimed token asserted
  byte-identical at completion and a console capture proving tokens
  and the API key are never logged.
- **Lint** (`tests/lint-run.log`): `n8n-node lint` **exit 0**
  (after the fixes and the two justified per-line exceptions above).

## Gaps — stated plainly

- **Mocked-contract scope only.** Canned responses are copied from
  production shapes (the same fixtures the Dify surface was
  live-verified against), but this package has not run against a
  live Sealgraf deployment, nor inside a live n8n instance — the
  suite stubs the execute-functions object rather than booting n8n.
  In particular, the evidence *collection* parameter's
  "only fields the user added are present" semantics are n8n's
  documented collection behavior, not something re-proven here.
- **The community scanner could not run**: `@n8n/scan-community-package`
  analyzes the package as published on npm and returns 404 for
  `n8n-nodes-sealgraf` because nothing is published
  (`tests/scan-run.log`). It becomes runnable only after a publish.
- **Not published, no repo, not submitted.** Per the plan, the
  remaining steps are the founder's: create the public GitHub repo
  (package.json `repository` and the codex documentation URLs already
  name `github.com/saiarung27/n8n-nodes-sealgraf`, which does not
  exist yet), configure npm Trusted Publishers (or an NPM_TOKEN),
  publish **from GitHub Actions with provenance** (the scaffold's
  `.github/workflows/publish.yml` ships ready and inert; verified
  status requires CI publishing since 2026-05-01), then submit in
  the n8n Creator Portal. Reviews can take up to four weeks.
- The scaffold's `.agents/` docs, `AGENTS.md`, and CI workflow are
  kept from the official template; `dist/` is a local build artifact.

## Publish prep (2026-11-11)

Readiness-only pass; nothing published, no repo created, no
Creator Portal submission.

Changes:
- `package.json` — `files` gained the exclusion
  `!dist/tsconfig.tsbuildinfo`. The dry-run tarball previously swept
  in the 95.5 kB TypeScript build-info file; the payload is now
  exactly the intended files.
- `README.md` — **Get Receipt** row now states the production
  routes (preauthorization ID → `GET /v1/preauthorize/{id}`; receipt
  ID → `GET /v1/receipts/{id}`; exactly one of the two).
- `package.json` metadata otherwise already complete (author with
  support email, homepage, repository, MIT license) — no changes.

Validation:
- `npm test` (build + node:test) re-run after the edits:
  **34 passed / 0 failed** (`tests/prep-20261111-test-run.log`).
- `npm run lint` (`n8n-node lint`): **exit 0**
  (`tests/prep-20261111-lint-run.log`) — the files-field change did
  not trip the linter (house rule: CLI used, findings addressed).
- `npm pack --dry-run` after the fix: **14 files**, package size
  60.6 kB → **32.8 kB**, no `tsconfig.tsbuildinfo` in the listing.

Still founder-gated (unchanged from Gaps): the public GitHub repo
named in `package.json`/`codex` (github.com/saiarung27/
n8n-nodes-sealgraf) does not exist yet — its creation gates
provenance publishing and Creator Portal verification — and no
LICENSE file ships (holder name is an open founder call). See
`~/workspace/see-plan/publish-readiness-20261111.md`.

## Founder rulings applied (2026-11-12)

- LICENSE added at repo root: MIT, "Copyright (c) 2026 Sai Arun Gunuganti".
- `package.json` author: the string form "Sai Arun Gunuganti
  <support@sealgraf.com>" was applied, then REVERTED — `n8n-node lint`
  failed with rule `community-package-json-author-name-missing` ("Add an
  `author.name` key to package.json", lint exit 1; log
  `tests/rulings-lint.log`). The linter requires the object form. Author
  therefore remains `{ "name": "saiarung27", "email":
  "support@sealgraf.com" }` pending a lint-compatible ruling (object form
  with name "Sai Arun Gunuganti" would satisfy both the linter and the
  author ruling). The public-repo creation/push for this package was NOT
  done, per the stop-on-red rule.
- Mocked suite re-run after the revert: **34 passed / 0 failed** and
  `n8n-node lint` exit 0 (`tests/rulings-run.log`,
  `tests/rulings-lint-after-revert.log`).
