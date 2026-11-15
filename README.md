# n8n-nodes-sealgraf

This is an n8n community node. It lets you use [Sealgraf](https://sealgraf.com) in your n8n workflows.

Sealgraf is the permission layer for agent spending: an agent checks with Sealgraf **before** it buys, the owner approves purchases above the limit they set, and every completed purchase is sealed into a receipt the owner can verify. This node exposes that loop as one node with four operations, so a deterministic n8n workflow can run it step by step — check, wait for the owner's approval, claim, complete.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

For GUI installation, search for `n8n-nodes-sealgraf` under **Settings → Community nodes**. For a manual install in a self-hosted instance:

```bash
cd ~/.n8n/custom
npm install n8n-nodes-sealgraf
```

## Operations

One node, four operations. Amounts are always in the currency's **minor units** (for example, `2500` with currency `USD` means $25.00) — the same convention as the Sealgraf API.

| Operation | What it does |
| --- | --- |
| **Check Permission** | Ask Sealgraf whether a purchase may proceed, before any money moves. Returns `allow`, `deny`, or `needs_human_approval`. An immediate `allow` includes the single-use `decision_token`. |
| **Claim Decision Token** | After the owner approves a check that returned `needs_human_approval`, claim the single-use decision token minted by that approval. |
| **Complete Purchase** | After the purchase has actually happened, report it and seal the receipt. Requires the decision token and (node version 1.1) the amount charged; optional evidence (merchant reference, payment details) is sealed with it. |
| **Get Receipt** | Look up a preauthorization by its ID (reads `GET /v1/preauthorize/{id}` — its state, decision, and receipt ID) or a sealed receipt by its ID (reads `GET /v1/receipts/{id}`). Give exactly one of the two IDs. |

Categories are a closed list, identical to the Sealgraf API: `groceries`, `household`, `dining`, `travel`, `software`, `office_supplies`, `shopping`, `transport`, `entertainment`, `health`, `supplies`, `materials`, `equipment`, `fuel`, `services`, `shipping`, `repairs`.

### Fail-closed behavior

This node never guesses about permission. A timeout, a network error, an unexpected response, or any API error fails the node execution (or produces an `error` item when the node is set to continue on fail) — it never produces an "allowed" output. A fresh `allow` that arrives without a decision token is treated as malformed and fails the same way.

One honest exception: if a **Check Permission** call is repeated with the same **Idempotency Key**, Sealgraf returns the original check marked `replayed: true` and does **not** re-serve the decision token (only its hash is stored). The node surfaces that as `decision_token_redelivered: false`. Use the token from the first response; if it is lost, run a fresh check without the idempotency key.

Claim refusals are API errors whose message carries the server's stable code, for example `[code: not_approved_yet]`. The codes are: `not_approved_yet`, `decision_token_expired`, `wrong_owner_key`, `already_completed`, `denied`, `expired`, `not_found`.

## Credentials

The node uses a **Sealgraf API** credential:

- **Base URL** — defaults to `https://sealgraf.com`. Change it only for a self-hosted or test deployment.
- **API Key** — an *agent-scope* API key from your Sealgraf account (Sealgraf → your agent's connection → API key). The key is sent as the `X-API-Key` header and never appears in node output.

The credential's built-in test performs `GET /v1/receipts?limit=1`, the lightest authenticated read an agent key may make, so a green test means the key is valid for exactly the calls this node makes.

## Compatibility

Requires n8n with community-node support (n8n Nodes API version 1). The package has **zero runtime dependencies**; all HTTP goes through n8n's own authenticated request helper.

## Usage

### The spend loop, as a workflow

1. **Sealgraf (Check Permission)** — category, amount in minor units, currency, counterparty, and an idempotency key unique to this intended purchase.
2. **IF node** on `{{ $json.outcome }}`:
   - `deny` → stop. Do not buy.
   - `allow` → buy (outside Sealgraf), keeping `decision_token` and `preauth_id`.
   - `needs_human_approval` → pause the workflow here (for example a **Wait** node resumed by your approval step). The owner approves in Sealgraf; nothing about the approval happens in n8n.
3. **Sealgraf (Claim Decision Token)** — with the `preauth_id` from step 1. Only needed on the approval path; an immediate `allow` already carries its token.
4. Buy the item, if you have not already.
5. **Sealgraf (Complete Purchase)** — `preauth_id`, the decision token, the amount charged, and any completion evidence (merchant order reference, payment rail). Output includes the sealed `receipt_id`.
6. **Sealgraf (Get Receipt)** — optionally, read the sealed receipt back by receipt ID or preauthorization ID.

### Example: check parameters for a $25 grocery order

- Operation: `Check Permission`
- Category: `Groceries`
- Amount (Minor Units): `2500`
- Currency: `USD`
- Counterparty: `Corner Store`
- Idempotency Key: `weekly-groceries-2026-11-11` (any unique string, at least 8 characters)

Output (immediate allow):

```json
{
  "preauth_id": "pa_...",
  "state": "authorized",
  "outcome": "allow",
  "decision_token": "...",
  "token_expires_at": "2026-11-11T20:15:00Z",
  "replayed": false,
  "amount_minor": 2500,
  "currency": "USD",
  "category": "groceries"
}
```

Decision tokens are single-use and expire; pass them straight from the producing node's output into **Complete Purchase** with an expression, and do not log or store them elsewhere.

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
* [Sealgraf](https://sealgraf.com)

## Version history

### 0.1.3

Node version 1.1 (default for new nodes): Complete Purchase requires the amount charged. Existing workflows stay on version 1, unchanged. Adds the Services, Shipping and Repairs purchase kinds. See CHANGELOG.md.

### 0.1.0

First release: the Sealgraf node (Check Permission, Claim Decision Token, Complete Purchase, Get Receipt) and the Sealgraf API credentials type.
