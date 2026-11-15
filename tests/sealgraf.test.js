/**
 * Unit tests for the Sealgraf n8n node + credentials.
 *
 * The node's execute() is driven with a stubbed IExecuteFunctions
 * whose helpers.httpRequestWithAuthentication records every request
 * and answers from canned, production-shaped responses (the same
 * shapes the Dify/LangChain/CrewAI sibling suites use, taken from
 * signed-evidence-engine origin/main). The stub also applies the
 * credentials type's generic authenticate (X-API-Key header), which
 * is what n8n core does at runtime — so the recorded requests show
 * the header exactly as the service would receive it.
 *
 * No network, no live Sealgraf deployment: mocked-contract scope.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { Sealgraf } = require('../dist/nodes/Sealgraf/Sealgraf.node.js');
const { SealgrafApi } = require('../dist/credentials/SealgrafApi.credentials.js');
const clientLib = require('../dist/nodes/Sealgraf/SealgrafClient.js');

const API_KEY = 'see_test_agent_key_0001';
const TOKEN_1 = 'dtok_check_minted_AbC-123+/=';
const TOKEN_2 = 'dtok_claimed_XyZ-987+/=';

const CREDS = { apiKey: API_KEY, baseUrl: 'https://sealgraf.com' };

function checkBody(overrides = {}) {
	return {
		preauth_id: 'pa_0001',
		state: 'authorized',
		decision: { outcome: 'allow', reason_code: null },
		mandate_id: 'mnd_0001',
		mandate_version: 3,
		receipt_id: null,
		token_expires_at: '2026-11-11T20:15:00Z',
		ask_expires_at: null,
		replayed: false,
		decision_token: TOKEN_1,
		action: { amount_minor: 2500, currency: 'USD', category: 'groceries', counterparty: 'Corner Store' },
		...overrides,
	};
}

function preauthBody(overrides = {}) {
	return {
		preauth_id: 'pa_0001',
		state: 'completed',
		decision: { outcome: 'allow', reason_code: null },
		mandate_id: 'mnd_0001',
		mandate_version: 3,
		receipt_id: 'rcpt_0001',
		token_expires_at: null,
		ask_expires_at: null,
		was_allowed: true,
		approved_at: '2026-11-11T19:00:00Z',
		created_at: '2026-11-11T18:59:00Z',
		action: { amount_minor: 2500, currency: 'USD', category: 'groceries', counterparty: 'Corner Store' },
		...overrides,
	};
}

function receiptBody(overrides = {}) {
	return {
		receipt_id: 'rcpt_0001',
		preauth_id: 'pa_0001',
		entry_seq: 42,
		amount_minor: 2500,
		currency: 'USD',
		mandate_id: 'mnd_0001',
		created_at: '2026-11-11T19:05:00Z',
		completion: { completed_amount_minor: 2500 },
		payment_flag: null,
		...overrides,
	};
}

/**
 * Build a fake IExecuteFunctions. `responder(call)` returns
 * { statusCode, body } or throws (transport failure).
 */
function makeContext({ params = {}, credentials = CREDS, responder, continueOnFail = false, typeVersion = 1 }) {
	const calls = [];
	const ctx = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _itemIndex, fallback) =>
			Object.prototype.hasOwnProperty.call(params, name) ? params[name] : fallback,
		getCredentials: async () => credentials,
		getNode: () => ({
			name: 'Sealgraf',
			type: 'n8n-nodes-sealgraf.sealgraf',
			typeVersion,
			position: [0, 0],
			parameters: {},
		}),
		getExecutionId: () => 'exec-test-1',
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async (credentialsType, options) => {
				// Simulate n8n core applying the credential's generic
				// authenticate: the X-API-Key header from the credential.
				const recorded = {
					credentialsType,
					...options,
					headers: { ...(options.headers ?? {}), 'X-API-Key': credentials.apiKey },
				};
				calls.push(recorded);
				return responder(recorded);
			},
		},
	};
	return { ctx, calls };
}

async function run(ctx) {
	return new Sealgraf().execute.call(ctx);
}

const okJson = (body, statusCode = 200) => () => ({ statusCode, body });

describe('node description', () => {
	it('exposes one Sealgraf node with the sealgrafApi credential', () => {
		const d = new Sealgraf().description;
		assert.equal(d.name, 'sealgraf');
		assert.equal(d.displayName, 'Sealgraf');
		assert.deepEqual(d.credentials, [{ name: 'sealgrafApi', required: true }]);
		const op = d.properties.find((p) => p.name === 'operation');
		assert.deepEqual(
			op.options.map((o) => o.value),
			['checkPermission', 'claimDecisionToken', 'completePurchase', 'getReceipt'],
		);
	});

	// AMENDED 2026-11-15 (0.1.3): production grew to 17 kinds with the
	// business purchase kinds (services, shipping, repairs).
	it('offers exactly the canonical 17 categories, in canonical order', () => {
		const d = new Sealgraf().description;
		const cat = d.properties.find((p) => p.name === 'category');
		assert.deepEqual(
			cat.options.map((o) => o.value),
			[...clientLib.CATEGORIES],
		);
		assert.deepEqual(
			cat.options.map((o) => o.value),
			[
				'groceries', 'household', 'dining', 'travel', 'software', 'office_supplies',
				'shopping', 'transport', 'entertainment', 'health', 'supplies', 'materials',
				'equipment', 'fuel', 'services', 'shipping', 'repairs',
			],
		);
	});
});

describe('credentials type', () => {
	it('sends the key as X-API-Key via generic authenticate', () => {
		const c = new SealgrafApi();
		assert.equal(c.name, 'sealgrafApi');
		assert.equal(c.authenticate.type, 'generic');
		assert.equal(c.authenticate.properties.headers['X-API-Key'], '={{$credentials.apiKey}}');
	});

	it('defaults the base URL to https://sealgraf.com and masks the key', () => {
		const c = new SealgrafApi();
		const base = c.properties.find((p) => p.name === 'baseUrl');
		const key = c.properties.find((p) => p.name === 'apiKey');
		assert.equal(base.default, 'https://sealgraf.com');
		assert.equal(key.typeOptions.password, true);
	});

	it('tests credentials with GET /v1/receipts?limit=1 (not the admin-gated mandates route)', () => {
		const c = new SealgrafApi();
		assert.equal(c.test.request.url, '/v1/receipts');
		assert.equal(c.test.request.method, 'GET');
		assert.deepEqual(c.test.request.qs, { limit: 1 });
		assert.equal(c.test.request.baseURL, '={{$credentials.baseUrl}}');
	});
});

describe('check permission', () => {
	const baseParams = {
		operation: 'checkPermission',
		category: 'groceries',
		amountMinor: 2500,
		currency: 'USD',
		counterparty: 'Corner Store',
		itemDescription: 'Weekly groceries',
		agentId: '',
		mandateId: '',
		idempotencyKey: 'order-1234-abcd',
	};

	it('sends the exact CheckIn shape with the API key header and parses a fresh allow', async () => {
		const { ctx, calls } = makeContext({
			params: baseParams,
			responder: okJson(checkBody(), 201),
		});
		const [items] = await run(ctx);
		assert.equal(calls.length, 1);
		const call = calls[0];
		assert.equal(call.credentialsType, 'sealgrafApi');
		assert.equal(call.method, 'POST');
		assert.equal(call.url, 'https://sealgraf.com/v1/preauthorize');
		assert.equal(call.headers['X-API-Key'], API_KEY);
		assert.equal(call.headers['Content-Type'], 'application/json');
		assert.deepEqual(call.body, {
			action: {
				category: 'groceries',
				amount_minor: 2500,
				currency: 'USD',
				counterparty: 'Corner Store',
				description: 'Weekly groceries',
			},
			idempotency_key: 'order-1234-abcd',
		});
		const out = items[0].json;
		assert.equal(out.outcome, 'allow');
		assert.equal(out.preauth_id, 'pa_0001');
		assert.equal(out.decision_token, TOKEN_1);
		assert.equal(out.replayed, false);
		assert.equal(out.amount_minor, 2500);
	});

	it('omits empty optional fields from the wire body', async () => {
		const { ctx, calls } = makeContext({
			params: { ...baseParams, currency: '', counterparty: '', itemDescription: '', idempotencyKey: '' },
			responder: okJson(checkBody(), 201),
		});
		await run(ctx);
		assert.deepEqual(calls[0].body, { action: { category: 'groceries', amount_minor: 2500 } });
	});

	it('surfaces needs_human_approval as a normal outcome, with no token', async () => {
		const body = checkBody({
			state: 'pending_approval',
			decision: { outcome: 'needs_human_approval', reason_code: 'over_ask_threshold' },
			decision_token: undefined,
			token_expires_at: null,
			ask_expires_at: '2026-11-12T19:00:00Z',
		});
		delete body.decision_token;
		const { ctx } = makeContext({ params: baseParams, responder: okJson(body, 201) });
		const [items] = await run(ctx);
		assert.equal(items[0].json.outcome, 'needs_human_approval');
		assert.equal(items[0].json.state, 'pending_approval');
		assert.ok(!('decision_token' in items[0].json));
	});

	it('surfaces a deny as a normal outcome', async () => {
		const body = checkBody({
			state: 'denied',
			decision: { outcome: 'deny', reason_code: 'over_hard_limit' },
		});
		delete body.decision_token;
		const { ctx } = makeContext({ params: baseParams, responder: okJson(body, 201) });
		const [items] = await run(ctx);
		assert.equal(items[0].json.outcome, 'deny');
		assert.equal(items[0].json.reason_code, 'over_hard_limit');
	});

	it('flags an idempotent replay honestly: no token re-delivered, never a fresh permission', async () => {
		const body = checkBody({ replayed: true });
		delete body.decision_token;
		const { ctx } = makeContext({ params: baseParams, responder: okJson(body, 200) });
		const [items] = await run(ctx);
		const out = items[0].json;
		assert.equal(out.replayed, true);
		assert.equal(out.decision_token_redelivered, false);
		assert.ok(!('decision_token' in out));
	});

	it('fails closed on a FRESH allow with no decision token', async () => {
		const body = checkBody({ replayed: false });
		delete body.decision_token;
		const { ctx } = makeContext({ params: baseParams, responder: okJson(body, 201) });
		await assert.rejects(run(ctx), /no decision_token was returned\. Failing closed/);
	});

	it('rejects a non-canonical category before any HTTP call', async () => {
		const { ctx, calls } = makeContext({
			params: { ...baseParams, category: 'weapons' },
			responder: okJson(checkBody(), 201),
		});
		await assert.rejects(run(ctx), /category must be one of/);
		assert.equal(calls.length, 0);
	});

	it('rejects a zero or fractional amount before any HTTP call', async () => {
		for (const amountMinor of [0, -5, 10.5]) {
			const { ctx, calls } = makeContext({
				params: { ...baseParams, amountMinor },
				responder: okJson(checkBody(), 201),
			});
			await assert.rejects(run(ctx), /amount_minor/);
			assert.equal(calls.length, 0);
		}
	});

	it('rejects an idempotency key shorter than 8 characters before any HTTP call', async () => {
		const { ctx, calls } = makeContext({
			params: { ...baseParams, idempotencyKey: 'short' },
			responder: okJson(checkBody(), 201),
		});
		await assert.rejects(run(ctx), /idempotency_key must be at least 8 characters/);
		assert.equal(calls.length, 0);
	});
});

describe('claim decision token', () => {
	const params = { operation: 'claimDecisionToken', preauthId: 'pa_0001' };

	it('posts an empty JSON body and returns the token byte-identical', async () => {
		const { ctx, calls } = makeContext({
			params,
			responder: okJson({ decision_token: TOKEN_2, token_expires_at: '2026-11-11T20:15:00Z' }),
		});
		const [items] = await run(ctx);
		assert.equal(calls[0].method, 'POST');
		assert.equal(calls[0].url, 'https://sealgraf.com/v1/preauthorize/pa_0001/decision-token');
		assert.deepEqual(calls[0].body, {});
		assert.equal(items[0].json.decision_token, TOKEN_2);
		assert.equal(items[0].json.claimed, true);
	});

	it('surfaces every production refusal code intact in the node error', async () => {
		const cases = [
			['not_approved_yet', 409],
			['decision_token_expired', 409],
			['wrong_owner_key', 409],
			['already_completed', 409],
			['denied', 409],
			['expired', 409],
			['not_found', 404],
		];
		for (const [code, status] of cases) {
			const { ctx } = makeContext({
				params,
				responder: okJson({ detail: `refused: ${code}`, code }, status),
			});
			await assert.rejects(run(ctx), (error) => {
				assert.equal(error.httpCode, String(status));
				assert.ok(
					error.message.includes(`[code: ${code}]`),
					`expected code ${code} in: ${error.message}`,
				);
				return true;
			});
		}
	});
});

describe('complete purchase, node version 1.1', () => {
	const params = {
		operation: 'completePurchase',
		preauthId: 'pa_0001',
		decisionToken: TOKEN_2,
		completionNonce: 'nonce-abc-1',
		evidence: { note: 'Delivered' },
	};
	const sealed = okJson({
		receipt_id: 'rcpt_0001', preauth_id: 'pa_0001', entry_seq: 42,
		amount_minor: 2500, currency: 'USD', mandate_id: 'mnd_0001',
		created_at: '2026-11-11T19:05:00Z',
	});

	it('is the default version and shows Amount Charged only from 1.1', () => {
		const d = new Sealgraf().description;
		assert.deepEqual(d.version, [1, 1.1]);
		assert.equal(d.defaultVersion, 1.1);
		const field = d.properties.find((p) => p.name === 'amountChargedMinor');
		assert.equal(field.required, true);
		assert.deepEqual(field.displayOptions.show['@version'], [{ _cnd: { gte: 1.1 } }]);
	});

	it('sends the amount charged from its own field', async () => {
		const { ctx, calls } = makeContext({
			params: { ...params, amountChargedMinor: 2499 }, responder: sealed, typeVersion: 1.1,
		});
		await run(ctx);
		assert.deepEqual(calls[0].body.evidence, { completed_amount_minor: 2499, note: 'Delivered' });
	});

	it('refuses a missing or zero amount before any HTTP call', async () => {
		for (const amount of [undefined, 0, -5]) {
			const p = { ...params };
			if (amount !== undefined) p.amountChargedMinor = amount;
			const { ctx, calls } = makeContext({ params: p, responder: sealed, typeVersion: 1.1 });
			await assert.rejects(run(ctx), /amount_charged_minor/);
			assert.equal(calls.length, 0);
		}
	});

	it('version 1 workflows keep the optional evidence amount', async () => {
		const { ctx, calls } = makeContext({ params, responder: sealed, typeVersion: 1 });
		await run(ctx);
		assert.deepEqual(calls[0].body.evidence, { note: 'Delivered' });
	});
});

describe('complete purchase', () => {
	const params = {
		operation: 'completePurchase',
		preauthId: 'pa_0001',
		decisionToken: TOKEN_2,
		completionNonce: 'nonce-abc-1',
		evidence: {},
	};
	const sealed = okJson({
		receipt_id: 'rcpt_0001',
		preauth_id: 'pa_0001',
		entry_seq: 42,
		amount_minor: 2500,
		currency: 'USD',
		mandate_id: 'mnd_0001',
		created_at: '2026-11-11T19:05:00Z',
	});

	it('seals a completion with no evidence', async () => {
		const { ctx, calls } = makeContext({ params, responder: sealed });
		const [items] = await run(ctx);
		assert.equal(calls[0].url, 'https://sealgraf.com/v1/preauthorize/pa_0001/complete');
		assert.deepEqual(calls[0].body, {
			decision_token: TOKEN_2,
			completion_nonce: 'nonce-abc-1',
			evidence: {},
		});
		assert.equal(items[0].json.sealed, true);
		assert.equal(items[0].json.receipt_id, 'rcpt_0001');
		assert.equal(items[0].json.entry_seq, 42);
	});

	it('sends the full closed evidence set, payment block included, over the wire', async () => {
		const evidence = {
			completedAmountMinor: 2499,
			counterpartyReceiptRef: 'ORDER-7781',
			note: 'Delivered',
			paymentRail: 'link_stripe',
			paymentInstrumentLabel: 'Visa',
			paymentInstrumentLast4: '2117',
			paymentVirtualLast4: '8342',
			paymentChargedAmountMinor: 2499,
			paymentCurrency: 'usd',
			paymentRailRefKind: 'charge',
			paymentRailRefValue: 'ch_123',
			paymentProvenance: 'browser_checkout',
		};
		const { ctx, calls } = makeContext({ params: { ...params, evidence }, responder: sealed });
		await run(ctx);
		assert.deepEqual(calls[0].body.evidence, {
			completed_amount_minor: 2499,
			counterparty_receipt_ref: 'ORDER-7781',
			note: 'Delivered',
			payment: {
				rail: 'link_stripe',
				instrument_label: 'Visa',
				instrument_last4: '2117',
				virtual_last4: '8342',
				charged_amount_minor: 2499,
				currency: 'USD',
				rail_ref: { kind: 'charge', value: 'ch_123' },
				provenance: 'browser_checkout',
			},
		});
	});

	it("allows a rail label only with rail 'other', and requires it there", async () => {
		for (const evidence of [
			{ paymentRail: 'paypal', paymentRailLabel: 'My Rail' },
			{ paymentRail: 'other' },
		]) {
			const { ctx, calls } = makeContext({ params: { ...params, evidence }, responder: sealed });
			await assert.rejects(run(ctx), /payment_rail_label/);
			assert.equal(calls.length, 0);
		}
		const { ctx, calls } = makeContext({
			params: { ...params, evidence: { paymentRail: 'other', paymentRailLabel: 'Barter' } },
			responder: sealed,
		});
		await run(ctx);
		assert.deepEqual(calls[0].body.evidence, { payment: { rail: 'other', rail_label: 'Barter' } });
	});

	it('enforces the charged-amount/currency and rail-ref pairing rules before HTTP', async () => {
		for (const evidence of [
			{ paymentChargedAmountMinor: 100 },
			{ paymentRailRefKind: 'charge' },
			{ paymentRailRefValue: 'ch_1' },
			{ paymentInstrumentLast4: '211' },
			{ paymentRail: 'venmo' },
		]) {
			const { ctx, calls } = makeContext({ params: { ...params, evidence }, responder: sealed });
			await assert.rejects(run(ctx), /payment_/);
			assert.equal(calls.length, 0);
		}
	});

	it('generates a stable completion nonce from the execution ID when none is given', async () => {
		const { ctx, calls } = makeContext({
			params: { ...params, completionNonce: '' },
			responder: sealed,
		});
		await run(ctx);
		assert.equal(calls[0].body.completion_nonce, 'n8n-exec-test-1-pa_0001');
	});
});

describe('get receipt', () => {
	it('looks up by preauthorization ID with a bodyless GET', async () => {
		const { ctx, calls } = makeContext({
			params: { operation: 'getReceipt', preauthId: 'pa_0001', receiptId: '' },
			responder: okJson(preauthBody()),
		});
		const [items] = await run(ctx);
		assert.equal(calls[0].method, 'GET');
		assert.equal(calls[0].url, 'https://sealgraf.com/v1/preauthorize/pa_0001');
		assert.equal(calls[0].body, undefined);
		assert.equal(items[0].json.found_via, 'preauth');
		assert.equal(items[0].json.state, 'completed');
		assert.equal(items[0].json.receipt_id, 'rcpt_0001');
	});

	it('looks up by receipt ID', async () => {
		const { ctx, calls } = makeContext({
			params: { operation: 'getReceipt', preauthId: '', receiptId: 'rcpt_0001' },
			responder: okJson(receiptBody()),
		});
		const [items] = await run(ctx);
		assert.equal(calls[0].url, 'https://sealgraf.com/v1/receipts/rcpt_0001');
		assert.equal(items[0].json.found_via, 'receipt');
		assert.equal(items[0].json.entry_seq, 42);
	});

	it('requires exactly one of the two IDs, before any HTTP call', async () => {
		for (const params of [
			{ operation: 'getReceipt', preauthId: '', receiptId: '' },
			{ operation: 'getReceipt', preauthId: 'pa_1', receiptId: 'rcpt_1' },
		]) {
			const { ctx, calls } = makeContext({ params, responder: okJson(preauthBody()) });
			await assert.rejects(run(ctx), /exactly one of preauth_id or receipt_id/);
			assert.equal(calls.length, 0);
		}
	});

	it('surfaces an unknown preauthorization as a 404 API error', async () => {
		const { ctx } = makeContext({
			params: { operation: 'getReceipt', preauthId: 'pa_nope', receiptId: '' },
			responder: okJson({ detail: 'preauthorization pa_nope not found' }, 404),
		});
		await assert.rejects(run(ctx), (error) => {
			assert.equal(error.httpCode, '404');
			assert.ok(error.message.includes('not found'));
			return true;
		});
	});
});

describe('fail-closed behavior', () => {
	const params = {
		operation: 'checkPermission',
		category: 'groceries',
		amountMinor: 2500,
		currency: 'USD',
		counterparty: '',
		itemDescription: '',
		agentId: '',
		mandateId: '',
		idempotencyKey: '',
	};

	it('a 401 is an error, never a permission', async () => {
		const { ctx } = makeContext({
			params,
			responder: okJson({ detail: 'invalid or missing API key' }, 401),
		});
		await assert.rejects(run(ctx), (error) => {
			assert.equal(error.httpCode, '401');
			assert.ok(error.message.includes('invalid or missing API key'));
			return true;
		});
	});

	it('a timeout fails closed with no permission output', async () => {
		const { ctx } = makeContext({
			params,
			responder: () => {
				throw new Error('Request timed out after 20000ms');
			},
		});
		await assert.rejects(run(ctx), /timed out \(POST \/v1\/preauthorize\)\. Failing closed/);
	});

	it('a network failure fails closed', async () => {
		const { ctx } = makeContext({
			params,
			responder: () => {
				throw new Error('socket hang up');
			},
		});
		await assert.rejects(run(ctx), /Failing closed: no permission was granted/);
	});

	it('a non-JSON 2xx body fails closed as malformed', async () => {
		const { ctx } = makeContext({
			params,
			responder: () => ({ statusCode: 200, body: '<html>oops</html>' }),
		});
		await assert.rejects(run(ctx), /not valid JSON\. Failing closed/);
	});

	it('a non-JSON error body still surfaces its text as the detail', async () => {
		const { ctx } = makeContext({
			params,
			responder: () => ({ statusCode: 502, body: 'Bad Gateway (proxy)' }),
		});
		await assert.rejects(run(ctx), /Bad Gateway \(proxy\)/);
	});

	it('a missing API key in the credential fails before any HTTP call', async () => {
		const { ctx, calls } = makeContext({
			params,
			credentials: { apiKey: '', baseUrl: 'https://sealgraf.com' },
			responder: okJson(checkBody(), 201),
		});
		await assert.rejects(run(ctx), /API key is missing/);
		assert.equal(calls.length, 0);
	});

	it('continueOnFail converts a failure into an error item instead of throwing', async () => {
		const { ctx } = makeContext({
			params,
			responder: okJson({ detail: 'invalid or missing API key' }, 401),
			continueOnFail: true,
		});
		const [items] = await run(ctx);
		assert.equal(items.length, 1);
		assert.ok(items[0].json.error.includes('invalid or missing API key'));
	});

	it('honors a custom base URL from the credential, trailing slash included', async () => {
		const { ctx, calls } = makeContext({
			params,
			credentials: { apiKey: API_KEY, baseUrl: 'https://uat.example.test/' },
			responder: okJson(checkBody(), 201),
		});
		await run(ctx);
		assert.equal(calls[0].url, 'https://uat.example.test/v1/preauthorize');
	});
});

describe('the full spend loop', () => {
	it('check -> claim -> complete passes the claimed token byte-identical and logs nothing', async () => {
		const logged = [];
		const original = {};
		for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
			original[level] = console[level];
			console[level] = (...args) => logged.push(args.join(' '));
		}
		try {
			const responder = (call) => {
				if (call.url.endsWith('/v1/preauthorize')) {
					return { statusCode: 201, body: checkBody() };
				}
				if (call.url.endsWith('/decision-token')) {
					return {
						statusCode: 200,
						body: { decision_token: TOKEN_2, token_expires_at: '2026-11-11T20:15:00Z' },
					};
				}
				if (call.url.endsWith('/complete')) {
					return {
						statusCode: 200,
						body: {
							receipt_id: 'rcpt_0001',
							preauth_id: 'pa_0001',
							entry_seq: 42,
							amount_minor: 2500,
							currency: 'USD',
							mandate_id: 'mnd_0001',
							created_at: '2026-11-11T19:05:00Z',
						},
					};
				}
				throw new Error(`unexpected URL ${call.url}`);
			};

			const check = makeContext({
				params: {
					operation: 'checkPermission', category: 'groceries', amountMinor: 2500,
					currency: 'USD', counterparty: 'Corner Store', itemDescription: '',
					agentId: '', mandateId: '', idempotencyKey: '',
				},
				responder,
			});
			const [checkItems] = await run(check.ctx);
			assert.equal(checkItems[0].json.decision_token, TOKEN_1);

			const claim = makeContext({
				params: { operation: 'claimDecisionToken', preauthId: checkItems[0].json.preauth_id },
				responder,
			});
			const [claimItems] = await run(claim.ctx);
			const claimedToken = claimItems[0].json.decision_token;
			assert.equal(claimedToken, TOKEN_2);

			const complete = makeContext({
				params: {
					operation: 'completePurchase', preauthId: 'pa_0001',
					decisionToken: claimedToken, completionNonce: 'nonce-loop-1', evidence: {},
				},
				responder,
			});
			const [completeItems] = await run(complete.ctx);
			assert.equal(complete.calls[0].body.decision_token, TOKEN_2);
			assert.equal(completeItems[0].json.sealed, true);
		} finally {
			for (const level of Object.keys(original)) {
				console[level] = original[level];
			}
		}
		const allLogged = logged.join('\n');
		assert.ok(!allLogged.includes(TOKEN_1), 'check token must never be logged');
		assert.ok(!allLogged.includes(TOKEN_2), 'claimed token must never be logged');
		assert.ok(!allLogged.includes(API_KEY), 'API key must never be logged');
	});
});
