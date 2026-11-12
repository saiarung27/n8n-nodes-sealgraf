/**
 * Fail-closed Sealgraf REST client semantics for the n8n Sealgraf node.
 *
 * This is a TypeScript port of the verified reference client
 * (dify-sealgraf-plugin/plugin/sealgraf_client.py), whose contract comes
 * from the production service code (signed-evidence-engine, origin/main):
 *
 * - Auth: an agent-scope API key in the `X-API-Key` header (applied by
 *   the Sealgraf credentials type, never by this module).
 * - `POST /v1/preauthorize` (201) takes production's `CheckIn` and
 *   answers with the `_preauth_out` shape; a decision token is present
 *   in that answer ONLY when the check itself minted one (an immediate
 *   `allow`).
 * - `POST /v1/preauthorize/{id}/decision-token` claims the token an
 *   owner approval minted; refusals are 409 `{"detail", "code"}`.
 * - `POST /v1/preauthorize/{id}/complete` takes `CompleteIn`
 *   (`decision_token`, `completion_nonce`, `evidence`) and returns the
 *   sealed receipt dict.
 * - `GET /v1/preauthorize/{id}` and `GET /v1/receipts/{id}` are reads.
 *
 * FAIL CLOSED: every transport error, timeout, non-2xx response, or
 * malformed body raises SealgrafError (or its SealgrafApiError
 * subclass). Nothing here ever fabricates a permission-shaped result,
 * and decision tokens are passed through untouched — never logged,
 * never transformed.
 */

export const DEFAULT_BASE_URL = 'https://sealgraf.com';

/**
 * The canonical category ids (production: see/notify.py
 * _CATEGORY_LABELS, mirrored by docs/AGENT_SETUP.md's canonical table).
 * Closed list — the ids are sealed into history and must never be
 * renamed. Display names are production's people-facing labels.
 */
export const CATEGORIES = [
	'groceries',
	'household',
	'dining',
	'travel',
	'software',
	'office_supplies',
	'shopping',
	'transport',
	'entertainment',
	'health',
	'supplies',
	'materials',
	'equipment',
	'fuel',
] as const;

export const CATEGORY_OPTIONS: Array<{ name: string; value: string }> = [
	{ name: 'Groceries', value: 'groceries' },
	{ name: 'Household', value: 'household' },
	{ name: 'Dining Out', value: 'dining' },
	{ name: 'Travel', value: 'travel' },
	{ name: 'Apps & Software', value: 'software' },
	{ name: 'Office Supplies', value: 'office_supplies' },
	{ name: 'Shopping', value: 'shopping' },
	{ name: 'Transport', value: 'transport' },
	{ name: 'Entertainment', value: 'entertainment' },
	{ name: 'Health', value: 'health' },
	{ name: 'Supplies', value: 'supplies' },
	{ name: 'Materials', value: 'materials' },
	{ name: 'Equipment', value: 'equipment' },
	{ name: 'Fuel', value: 'fuel' },
];

// Decision outcomes (production: see/models.py DecisionOutcome).
export const DECISION_OUTCOMES: ReadonlySet<string> = new Set([
	'allow',
	'deny',
	'needs_human_approval',
]);

// Completion-evidence payment vocabularies (production: see/service.py
// _PAYMENT_RAILS, _RAIL_REF_KINDS, _PAYMENT_PROVENANCES). Closed lists.
export const PAYMENT_RAILS: ReadonlySet<string> = new Set([
	'link_stripe',
	'paypal',
	'stripe_api',
	'card_on_merchant',
	'other',
]);
export const RAIL_REF_KINDS: ReadonlySet<string> = new Set([
	'charge',
	'payment_intent',
	'paypal_transaction',
	'other',
]);
export const PAYMENT_PROVENANCES: ReadonlySet<string> = new Set([
	'browser_checkout',
	'rail_api',
	'merchant_confirmation',
]);

const LAST4_RE = /^[0-9]{4}$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

export class SealgrafError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SealgrafError';
	}
}

export class SealgrafApiError extends SealgrafError {
	readonly statusCode: number;
	readonly detail: string;
	readonly code?: string;
	/** The raw error body, when it was a JSON object (kept so the node
	 * can hand it to n8n's NodeApiError, which takes the body object). */
	readonly responseBody?: Record<string, unknown>;

	constructor(
		statusCode: number,
		detail: string,
		code?: string,
		responseBody?: Record<string, unknown>,
	) {
		let message = `Sealgraf API error (HTTP ${statusCode}): ${detail}`;
		if (code) {
			message += ` [code: ${code}]`;
		}
		super(message);
		this.name = 'SealgrafApiError';
		this.statusCode = statusCode;
		this.detail = detail;
		this.code = code;
		this.responseBody = responseBody;
	}
}

export function normalizeBaseUrl(raw?: string | null): string {
	let url = (raw ?? '').trim() || DEFAULT_BASE_URL;
	url = url.replace(/\/+$/, '');
	if (!url.startsWith('https://') && !url.startsWith('http://')) {
		throw new SealgrafError(
			`Sealgraf base URL must start with https:// or http://, got: ${JSON.stringify(url)}`,
		);
	}
	return url;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Raw HTTP exchange as the node transport reports it: a status code and
 * the response body (already JSON-parsed when it was JSON at all). */
export interface RawResponse {
	status: number;
	data: unknown;
}

export interface TransportRequest {
	method: string;
	path: string;
	body?: Record<string, unknown>;
	qs?: Record<string, unknown>;
}

export type SealgrafTransport = (request: TransportRequest) => Promise<RawResponse>;

/**
 * Map a transport failure to the error this module raises for it.
 * Errors that are already ours, and errors that are already n8n-native
 * (the node's transport throws NodeOperationError, recognized by name so
 * this module needs no n8n import), pass through unchanged; anything
 * else is wrapped in the fail-closed SealgrafError. The node's execute()
 * converts SealgrafError/SealgrafApiError into NodeOperationError/
 * NodeApiError at the node boundary.
 */
function asSealgrafError(error: unknown, method: string, path: string): Error {
	if (error instanceof SealgrafError) {
		return error;
	}
	if (
		error instanceof Error &&
		(error.name === 'NodeOperationError' || error.name === 'NodeApiError')
	) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	return new SealgrafError(
		`Sealgraf request failed (${method} ${path}): ${message}. ` +
			'Failing closed: no permission was granted.',
	);
}

async function request(
	transport: SealgrafTransport,
	method: string,
	path: string,
	options: {
		body?: Record<string, unknown>;
		qs?: Record<string, unknown>;
		expected?: number[];
	} = {},
): Promise<Record<string, unknown>> {
	const expected = options.expected ?? [200, 201];
	let response: RawResponse | undefined;
	let transportError: unknown;
	let transportFailed = false;
	try {
		response = await transport({ method, path, body: options.body, qs: options.qs });
	} catch (error) {
		transportFailed = true;
		transportError = error;
	}
	if (transportFailed || response === undefined) {
		throw asSealgrafError(transportError, method, path);
	}
	if (!expected.includes(response.status)) {
		let detail = '';
		let code: string | undefined;
		const payload = response.data;
		const responseBody = isRecord(payload) ? payload : undefined;
		if (isRecord(payload)) {
			const rawDetail = payload.detail;
			if (typeof rawDetail === 'string') {
				detail = rawDetail;
			} else if (rawDetail !== null && rawDetail !== undefined) {
				detail = String(rawDetail);
			}
			if (typeof payload.code === 'string') {
				code = payload.code;
			}
		}
		if (!detail) {
			detail =
				(typeof payload === 'string' ? payload.trim().slice(0, 300) : '') || 'no detail provided';
		}
		throw new SealgrafApiError(response.status, detail, code, responseBody);
	}
	if (typeof response.data === 'string') {
		throw new SealgrafError(
			`Malformed response from Sealgraf (${method} ${path}): ` +
				'body is not valid JSON. Failing closed.',
		);
	}
	if (!isRecord(response.data)) {
		throw new SealgrafError(
			`Malformed response from Sealgraf (${method} ${path}): ` +
				'expected a JSON object. Failing closed.',
		);
	}
	return response.data;
}

export interface CheckPermissionInput {
	category: string;
	amountMinor: number;
	currency?: string;
	counterparty?: string;
	description?: string;
	agentId?: string;
	mandateId?: string;
	idempotencyKey?: string;
}

export interface CompletePurchaseInput {
	decisionToken: string;
	completionNonce: string;
	evidence: Record<string, unknown>;
}

export class SealgrafClient {
	constructor(private readonly transport: SealgrafTransport) {}

	/**
	 * The lightest authenticated read an agent key may make:
	 * `GET /v1/receipts?limit=1` (production: see/api.py list_receipts —
	 * no scope restriction, unlike `GET /v1/mandates`, which refuses
	 * agent-scope keys). The credentials type's test request performs
	 * this same call; this method exists for completeness.
	 */
	async validateKey(): Promise<void> {
		const data = await request(this.transport, 'GET', '/v1/receipts', {
			qs: { limit: 1 },
			expected: [200],
		});
		if (!Array.isArray(data.items)) {
			throw new SealgrafError(
				'Malformed response from Sealgraf (GET /v1/receipts): ' +
					"expected an object with an 'items' list.",
			);
		}
	}

	/** POST /v1/preauthorize — body is production's `CheckIn`. */
	async checkPermission(input: CheckPermissionInput): Promise<Record<string, unknown>> {
		const action: Record<string, unknown> = {
			category: input.category,
			amount_minor: input.amountMinor,
		};
		if (input.agentId) {
			action.agent_id = input.agentId;
		}
		if (input.currency) {
			action.currency = input.currency;
		}
		if (input.counterparty) {
			action.counterparty = input.counterparty;
		}
		if (input.description) {
			action.description = input.description;
		}
		const body: Record<string, unknown> = { action };
		if (input.mandateId) {
			body.mandate_id = input.mandateId;
		}
		if (input.idempotencyKey) {
			body.idempotency_key = input.idempotencyKey;
		}
		return request(this.transport, 'POST', '/v1/preauthorize', {
			body,
			expected: [200, 201],
		});
	}

	/** POST /v1/preauthorize/{id}/decision-token (empty JSON body). */
	async claimDecisionToken(preauthId: string): Promise<Record<string, unknown>> {
		return request(this.transport, 'POST', `/v1/preauthorize/${preauthId}/decision-token`, {
			body: {},
			expected: [200],
		});
	}

	/** POST /v1/preauthorize/{id}/complete — body is `CompleteIn`. */
	async completePurchase(
		preauthId: string,
		input: CompletePurchaseInput,
	): Promise<Record<string, unknown>> {
		const body: Record<string, unknown> = {
			decision_token: input.decisionToken,
			completion_nonce: input.completionNonce,
			evidence: input.evidence,
		};
		return request(this.transport, 'POST', `/v1/preauthorize/${preauthId}/complete`, {
			body,
			expected: [200, 201],
		});
	}

	/** GET /v1/preauthorize/{id} — the `_preauth_out` shape. */
	async getPreauth(preauthId: string): Promise<Record<string, unknown>> {
		return request(this.transport, 'GET', `/v1/preauthorize/${preauthId}`, {
			expected: [200],
		});
	}

	/** GET /v1/receipts/{id} — receipt row + completion summary. */
	async getReceipt(receiptId: string): Promise<Record<string, unknown>> {
		return request(this.transport, 'GET', `/v1/receipts/${receiptId}`, {
			expected: [200],
		});
	}
}

// -- response shaping -----------------------------------------------------
// Each parser validates the production response shape before the node
// may present it. Anything unexpected raises SealgrafError: a response
// the node cannot understand is never rendered as a permission.

function requireResponseStr(data: Record<string, unknown>, field: string, context: string): string {
	const value = data[field];
	if (typeof value !== 'string' || !value) {
		throw new SealgrafError(
			`Malformed response from Sealgraf (${context}): ` +
				`'${field}' is missing or not a string. Failing closed.`,
		);
	}
	return value;
}

export function parseCheckResult(data: Record<string, unknown>): Record<string, unknown> {
	const preauthId = requireResponseStr(data, 'preauth_id', 'check_permission');
	const decision = data.decision;
	if (!isRecord(decision)) {
		throw new SealgrafError(
			'Malformed response from Sealgraf (check_permission): ' +
				"'decision' is missing or not an object. Failing closed.",
		);
	}
	const outcome = decision.outcome;
	if (typeof outcome !== 'string' || !DECISION_OUTCOMES.has(outcome)) {
		throw new SealgrafError(
			'Malformed response from Sealgraf (check_permission): ' +
				`unknown decision outcome ${JSON.stringify(outcome)}. Failing closed.`,
		);
	}
	const state = data.state;
	if (typeof state !== 'string' || !state) {
		throw new SealgrafError(
			'Malformed response from Sealgraf (check_permission): ' +
				"'state' is missing. Failing closed.",
		);
	}
	const result: Record<string, unknown> = {
		preauth_id: preauthId,
		state,
		outcome,
		reason_code: decision.reason_code ?? null,
		mandate_id: data.mandate_id ?? null,
		mandate_version: data.mandate_version ?? null,
		receipt_id: data.receipt_id ?? null,
		token_expires_at: data.token_expires_at ?? null,
		ask_expires_at: data.ask_expires_at ?? null,
		replayed: Boolean(data.replayed ?? false),
	};
	const action = data.action;
	if (isRecord(action)) {
		result.amount_minor = action.amount_minor ?? null;
		result.currency = action.currency ?? null;
		result.category = action.category ?? null;
	}
	if (outcome === 'allow') {
		// An allow is only usable with the single-use decision token the
		// check minted. Production includes it in exactly this case; its
		// absence on a FRESH answer means the answer cannot be trusted —
		// fail closed. One documented exception (see/api.py, A5): an
		// idempotent replay (HTTP 200, "replayed": true) returns the
		// original record and deliberately does NOT re-serve the token
		// (only its hash is stored). That shape is surfaced honestly,
		// flagged, and never presented as a fresh permission.
		const token = data.decision_token;
		if (typeof token === 'string' && token) {
			result.decision_token = token;
		} else if (result.replayed) {
			result.decision_token_redelivered = false;
		} else {
			throw new SealgrafError(
				'Malformed response from Sealgraf (check_permission): ' +
					"outcome is 'allow' but no decision_token was returned. " +
					'Failing closed: do not buy.',
			);
		}
	}
	return result;
}

export function parseClaimResult(
	data: Record<string, unknown>,
	preauthId: string,
): Record<string, unknown> {
	const token = data.decision_token;
	if (typeof token !== 'string' || !token) {
		throw new SealgrafError(
			'Malformed response from Sealgraf (claim_decision_token): ' +
				'no decision_token in the response. Failing closed.',
		);
	}
	return {
		preauth_id: preauthId,
		claimed: true,
		decision_token: token,
		token_expires_at: data.token_expires_at ?? null,
	};
}

export function parseCompleteResult(data: Record<string, unknown>): Record<string, unknown> {
	const receiptId = requireResponseStr(data, 'receipt_id', 'complete_purchase');
	return {
		sealed: true,
		receipt_id: receiptId,
		preauth_id: data.preauth_id ?? null,
		entry_seq: data.entry_seq ?? null,
		amount_minor: data.amount_minor ?? null,
		currency: data.currency ?? null,
		mandate_id: data.mandate_id ?? null,
		created_at: data.created_at ?? null,
	};
}

export function parsePreauthResult(data: Record<string, unknown>): Record<string, unknown> {
	const preauthId = requireResponseStr(data, 'preauth_id', 'get_receipt');
	const decision = isRecord(data.decision) ? data.decision : {};
	const action = isRecord(data.action) ? data.action : {};
	return {
		found_via: 'preauth',
		preauth_id: preauthId,
		state: data.state ?? null,
		outcome: decision.outcome ?? null,
		reason_code: decision.reason_code ?? null,
		receipt_id: data.receipt_id ?? null,
		mandate_id: data.mandate_id ?? null,
		mandate_version: data.mandate_version ?? null,
		amount_minor: action.amount_minor ?? null,
		currency: action.currency ?? null,
		category: action.category ?? null,
		counterparty: action.counterparty ?? null,
		was_allowed: data.was_allowed ?? null,
		approved_at: data.approved_at ?? null,
		token_expires_at: data.token_expires_at ?? null,
		ask_expires_at: data.ask_expires_at ?? null,
		created_at: data.created_at ?? null,
	};
}

export function parseReceiptResult(data: Record<string, unknown>): Record<string, unknown> {
	const receiptId = requireResponseStr(data, 'receipt_id', 'get_receipt');
	return {
		found_via: 'receipt',
		receipt_id: receiptId,
		preauth_id: data.preauth_id ?? null,
		entry_seq: data.entry_seq ?? null,
		amount_minor: data.amount_minor ?? null,
		currency: data.currency ?? null,
		mandate_id: data.mandate_id ?? null,
		created_at: data.created_at ?? null,
		completion: data.completion ?? null,
		payment_flag: data.payment_flag ?? null,
	};
}

// -- parameter validation ---------------------------------------------------
// Shared by the node; runs BEFORE any HTTP call so bad input fails with
// a clear local message and never reaches the service.

export function requireAmountMinor(value: unknown, field: string): number {
	if (typeof value === 'boolean' || value === null || value === undefined) {
		throw new SealgrafError(`${field} is required and must be a positive integer (minor units).`);
	}
	if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
		throw new SealgrafError(`${field} must be a whole number of minor units, got ${value}.`);
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new SealgrafError(
			`${field} must be an integer (minor units), got ${JSON.stringify(value)}.`,
		);
	}
	if (value <= 0) {
		throw new SealgrafError(`${field} must be greater than 0, got ${value}.`);
	}
	return value;
}

export function optionalStr(value: unknown): string | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}
	const text = String(value).trim();
	return text || undefined;
}

export function requireStr(value: unknown, field: string): string {
	const text = optionalStr(value);
	if (text === undefined) {
		throw new SealgrafError(`${field} is required.`);
	}
	return text;
}

export function validateCurrency(value: unknown): string | undefined {
	const text = optionalStr(value);
	if (text === undefined) {
		return undefined;
	}
	if (!CURRENCY_RE.test(text)) {
		throw new SealgrafError(`currency must be a three-letter code, got ${JSON.stringify(text)}.`);
	}
	return text.toUpperCase();
}

export function validateLast4(value: unknown, field: string): string | undefined {
	const text = optionalStr(value);
	if (text === undefined) {
		return undefined;
	}
	if (!LAST4_RE.test(text)) {
		throw new SealgrafError(`${field} must be exactly four digits, as a string.`);
	}
	return text;
}

function validatedChoice(
	value: unknown,
	choices: ReadonlySet<string>,
	field: string,
): string | undefined {
	const text = optionalStr(value);
	if (text === undefined) {
		return undefined;
	}
	if (!choices.has(text)) {
		throw new SealgrafError(
			`${field} must be one of: ${[...choices].sort().join(', ')}; ` +
				`got ${JSON.stringify(text)}.`,
		);
	}
	return text;
}

function optionalAmount(value: unknown, field: string): number | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}
	return requireAmountMinor(value, field);
}

/**
 * Assemble the completion evidence object from the node's flat evidence
 * parameters (camelCase keys). The wire key set is CLOSED in production
 * (see/service.py `_SEALED_EVIDENCE_KEYS`): completed_amount_minor,
 * counterparty_receipt_ref, note, completed_at, payment. Unknown keys
 * are refused by the service, so this builder only ever emits sealed
 * keys, and only when the caller actually supplied them. All cross-field
 * rules are enforced here, before any HTTP call.
 */
export function buildEvidence(params: Record<string, unknown>): Record<string, unknown> {
	const evidence: Record<string, unknown> = {};
	const completed = optionalAmount(params.completedAmountMinor, 'completed_amount_minor');
	if (completed !== undefined) {
		evidence.completed_amount_minor = completed;
	}
	const ref = optionalStr(params.counterpartyReceiptRef);
	if (ref !== undefined) {
		evidence.counterparty_receipt_ref = ref;
	}
	const note = optionalStr(params.note);
	if (note !== undefined) {
		evidence.note = note;
	}

	const payment: Record<string, unknown> = {};
	const rail = validatedChoice(params.paymentRail, PAYMENT_RAILS, 'payment_rail');
	if (rail !== undefined) {
		payment.rail = rail;
	}
	const railLabel = optionalStr(params.paymentRailLabel);
	if (railLabel !== undefined) {
		if (rail !== 'other') {
			throw new SealgrafError("payment_rail_label is only allowed when payment_rail is 'other'.");
		}
		payment.rail_label = railLabel;
	} else if (rail === 'other') {
		throw new SealgrafError("payment_rail_label is required when payment_rail is 'other'.");
	}
	const instrumentLabel = optionalStr(params.paymentInstrumentLabel);
	if (instrumentLabel !== undefined) {
		payment.instrument_label = instrumentLabel;
	}
	const instrumentLast4 = validateLast4(params.paymentInstrumentLast4, 'payment_instrument_last4');
	if (instrumentLast4 !== undefined) {
		payment.instrument_last4 = instrumentLast4;
	}
	const virtualLast4 = validateLast4(params.paymentVirtualLast4, 'payment_virtual_last4');
	if (virtualLast4 !== undefined) {
		payment.virtual_last4 = virtualLast4;
	}
	const chargedRaw = params.paymentChargedAmountMinor;
	if (chargedRaw !== null && chargedRaw !== undefined) {
		if (typeof chargedRaw !== 'number' || !Number.isFinite(chargedRaw)) {
			throw new SealgrafError('payment_charged_amount_minor must be an integer (minor units).');
		}
		if (!Number.isInteger(chargedRaw)) {
			throw new SealgrafError(
				'payment_charged_amount_minor must be a whole number of minor units.',
			);
		}
		if (chargedRaw < 0) {
			throw new SealgrafError('payment_charged_amount_minor cannot be negative.');
		}
		payment.charged_amount_minor = chargedRaw;
	}
	const paymentCurrency = validateCurrency(params.paymentCurrency);
	if (paymentCurrency !== undefined) {
		payment.currency = paymentCurrency;
	}
	if ('charged_amount_minor' in payment && !('currency' in payment)) {
		throw new SealgrafError(
			'payment_currency is required when payment_charged_amount_minor ' +
				'is supplied (an amount without its unit is not a fact).',
		);
	}
	const refKind = validatedChoice(
		params.paymentRailRefKind,
		RAIL_REF_KINDS,
		'payment_rail_ref_kind',
	);
	const refValue = optionalStr(params.paymentRailRefValue);
	if ((refKind === undefined) !== (refValue === undefined)) {
		throw new SealgrafError(
			'payment_rail_ref_kind and payment_rail_ref_value must be supplied together.',
		);
	}
	if (refKind !== undefined) {
		payment.rail_ref = { kind: refKind, value: refValue };
	}
	const provenance = validatedChoice(
		params.paymentProvenance,
		PAYMENT_PROVENANCES,
		'payment_provenance',
	);
	if (provenance !== undefined) {
		payment.provenance = provenance;
	}
	if (Object.keys(payment).length > 0) {
		evidence.payment = payment;
	}
	return evidence;
}
