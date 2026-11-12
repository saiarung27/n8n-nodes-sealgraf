/**
 * LIVE harness for the Sealgraf n8n node.
 *
 * Drives the BUILT node's execute() (dist/) with an IExecuteFunctions
 * whose helpers.httpRequestWithAuthentication performs REAL HTTPS
 * requests to the Sealgraf UAT deployment. The helper reproduces
 * n8n core's contract faithfully:
 *   - it loads the credential for the requested type,
 *   - applies the credentials type's generic `authenticate` (the
 *     X-API-Key header template is read from the package's own
 *     SealgrafApi credentials class and its ={{$credentials.x}}
 *     expressions are resolved against the credential values),
 *   - serializes the body as JSON, appends qs, honors `timeout`,
 *     `returnFullResponse` and `ignoreHttpStatusErrors`
 *     (HTTP statuses resolve, transport failures throw).
 * Only n8n's runtime host is substituted; the node code, the client,
 * the credential plumbing and the Sealgraf service are all real.
 *
 * The API key and every decision token are kept in memory only, are
 * registered as scrub secrets, and are never printed or written to
 * the log (token lengths only).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { Sealgraf } = require('../dist/nodes/Sealgraf/Sealgraf.node.js');
const { SealgrafApi } = require('../dist/credentials/SealgrafApi.credentials.js');

const BASE_URL = 'https://see-app-uat.onrender.com';
const KEY_PATH = '/home/hatch/workspace/.test-scratch/dify-gate1/key.txt';
const LOG_PATH = path.join(__dirname, 'live-run.log');
const OWNER_EMAIL = 'dify-gate1-20261111@example.com';
const OWNER_PASSWORD = 'DifyGate2026!Seal';

const API_KEY = fs.readFileSync(KEY_PATH, 'utf8').trim();
const CREDS = { apiKey: API_KEY, baseUrl: BASE_URL };

// -- scrubbed logging -------------------------------------------------
const secrets = new Set([API_KEY]);
function scrub(text) {
	let out = String(text);
	for (const s of secrets) {
		if (s) out = out.split(s).join(`<redacted len=${s.length}>`);
	}
	return out;
}
const priorLog = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : '';
const attemptNo = (priorLog.match(/^=== ATTEMPT /gm) || []).length + 1;
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
function log(line) {
	const safe = scrub(line);
	logStream.write(safe + '\n');
	console.log(safe);
}
function pass(label) {
	log(`[PASS] ${label}`);
}

// -- the real authenticated-request helper ----------------------------
const credType = new SealgrafApi();

function resolveAuthHeaders(credentials) {
	// n8n core applies the credentials type's generic authenticate:
	// each declared header value is an expression template whose
	// ={{$credentials.<field>}} references are resolved against the
	// credential values. Read the template from the package's own
	// credentials class rather than hardcoding the header name.
	const headers = {};
	const props = (credType.authenticate && credType.authenticate.properties) || {};
	for (const [name, raw] of Object.entries(props.headers || {})) {
		headers[name] = String(raw).replace(
			/=?\{\{\s*\$credentials\.([A-Za-z0-9_]+)\s*\}\}/g,
			(_m, field) => String(credentials[field] ?? ''),
		);
	}
	return headers;
}

function makeContext(params, calls) {
	const ctx = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _itemIndex, fallback) =>
			Object.prototype.hasOwnProperty.call(params, name) ? params[name] : fallback,
		getCredentials: async (type) => {
			assert.equal(type, 'sealgrafApi');
			return CREDS;
		},
		getNode: () => ({
			name: 'Sealgraf',
			type: 'n8n-nodes-sealgraf.sealgraf',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		getExecutionId: () => 'live-harness-1',
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (credentialsType, options) => {
				assert.equal(credentialsType, 'sealgrafApi');
				const headers = { ...(options.headers || {}), ...resolveAuthHeaders(CREDS) };
				const url = new URL(options.url);
				if (options.qs) {
					for (const [k, v] of Object.entries(options.qs)) {
						url.searchParams.set(k, String(v));
					}
				}
				const init = { method: options.method, headers, redirect: 'manual' };
				if (options.body !== undefined) init.body = JSON.stringify(options.body);
				if (options.timeout) init.signal = AbortSignal.timeout(options.timeout);
				const started = Date.now();
				let res;
				try {
					res = await fetch(url, init);
				} catch (error) {
					calls.push({
						method: options.method,
						url: options.url,
						status: 'TRANSPORT_ERROR',
						ms: Date.now() - started,
					});
					throw error;
				}
				const text = await res.text();
				let body = text;
				try {
					body = JSON.parse(text);
				} catch {
					// Non-JSON: pass the raw text through, like the real
					// helper does when the body is not JSON.
				}
				calls.push({
					method: options.method,
					url: options.url,
					status: res.status,
					ms: Date.now() - started,
					apiKeyHeaderApplied: headers['X-API-Key'] === CREDS.apiKey,
				});
				if (!options.ignoreHttpStatusErrors && (res.status < 200 || res.status >= 300)) {
					throw new Error(`Request failed with status code ${res.status}`);
				}
				return { statusCode: res.status, body };
			},
		},
	};
	return ctx;
}

async function run(ctx) {
	return new Sealgraf().execute.call(ctx);
}

// -- owner session (approval + server-side confirmation) --------------
let cookieHeader = '';
async function ownerCall(method, urlPath, body) {
	const res = await fetch(BASE_URL + urlPath, {
		method,
		headers: {
			'Content-Type': 'application/json',
			Origin: BASE_URL,
			...(cookieHeader ? { Cookie: cookieHeader } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		redirect: 'manual',
		signal: AbortSignal.timeout(30000),
	});
	const setCookies =
		typeof res.headers.getSetCookie === 'function'
			? res.headers.getSetCookie()
			: [res.headers.get('set-cookie')].filter(Boolean);
	if (setCookies.length) {
		cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
	}
	const text = await res.text();
	let json = {};
	try {
		json = JSON.parse(text || '{}');
	} catch {
		json = {};
	}
	return { status: res.status, json };
}

async function main() {
	log(`=== ATTEMPT ${attemptNo} — ${new Date().toISOString()} ===`);
	log(`backend: ${BASE_URL} (throwaway gate-1 test tenant)`);
	log('driver: dist/nodes/Sealgraf/Sealgraf.node.js execute() + real HTTPS helper');

	// Pre-flight: the agent key alone (harness-side, not through the
	// node) — mirrors the credential test request GET /v1/receipts?limit=1.
	{
		const res = await fetch(`${BASE_URL}/v1/receipts?limit=1`, {
			headers: { 'X-API-Key': API_KEY },
			signal: AbortSignal.timeout(30000),
		});
		assert.equal(res.status, 200, `credential pre-flight expected 200, got ${res.status}`);
		await res.text();
		pass('credential pre-flight: GET /v1/receipts?limit=1 -> 200');
	}

	// ---------------- Loop A: instant allow ($3.00) ----------------
	const callsA = [];
	const checkA = makeContext(
		{
			operation: 'checkPermission',
			category: 'household',
			amountMinor: 300,
			currency: 'USD',
			counterparty: 'n8n Live Test',
			itemDescription: 'Live test, allow loop',
			agentId: '',
			mandateId: '',
			idempotencyKey: 'n8n-live-allow-001',
		},
		callsA,
	);
	const [checkAItems] = await run(checkA);
	const outA = checkAItems[0].json;
	assert.equal(outA.outcome, 'allow', `loop A outcome: ${outA.outcome}`);
	assert.equal(outA.state, 'authorized', `loop A state: ${outA.state}`);
	assert.equal(outA.amount_minor, 300, `loop A amount: ${outA.amount_minor}`);
	assert.equal(outA.replayed, false, 'loop A must be a fresh check, not a replay');
	const preauthA = outA.preauth_id;
	const tokenA = outA.decision_token;
	assert.equal(typeof tokenA, 'string');
	assert.ok(tokenA.length > 0, 'loop A allow must carry a decision token');
	secrets.add(tokenA);
	log(`loop A check: outcome=allow preauth=${preauthA} tokenLen=${tokenA.length}`);
	pass('loop A check: fresh allow with token');

	const completeAParams = {
		operation: 'completePurchase',
		preauthId: preauthA,
		decisionToken: tokenA,
		completionNonce: 'n8n-live-complete-001',
		evidence: {},
	};
	// Byte-identity: the token handed to Complete is exactly the string
	// the Check output carried (asserted, never printed).
	assert.strictEqual(completeAParams.decisionToken, tokenA);
	const [completeAItems] = await run(makeContext(completeAParams, callsA));
	const compA = completeAItems[0].json;
	assert.equal(compA.sealed, true, 'loop A completion must seal');
	assert.equal(compA.amount_minor, 300, `loop A sealed amount: ${compA.amount_minor}`);
	const receiptA = compA.receipt_id;
	assert.ok(receiptA, 'loop A completion must return a receipt_id');
	log(`loop A complete: sealed receipt=${receiptA} entry_seq=${compA.entry_seq}`);
	pass('loop A complete: receipt sealed, token byte-identical check->complete');

	const [receiptAItems] = await run(
		makeContext({ operation: 'getReceipt', preauthId: preauthA, receiptId: '' }, callsA),
	);
	assert.equal(receiptAItems[0].json.state, 'completed');
	assert.equal(receiptAItems[0].json.receipt_id, receiptA);
	pass('loop A getReceipt: state completed');
	log(
		`loop A wire: ${callsA.map((c) => `${c.method} ${c.url.replace(BASE_URL, '')} -> ${c.status} (apiKeyHeader=${c.apiKeyHeaderApplied})`).join(' | ')}`,
	);

	// ---------------- Loop B: owner approval ($25.00) --------------
	const callsB = [];
	const checkB = makeContext(
		{
			operation: 'checkPermission',
			category: 'household',
			amountMinor: 2500,
			currency: 'USD',
			counterparty: 'n8n Live Test',
			itemDescription: 'Live test, approval loop',
			agentId: '',
			mandateId: '',
			idempotencyKey: 'n8n-live-appr-001',
		},
		callsB,
	);
	const [checkBItems] = await run(checkB);
	const outB = checkBItems[0].json;
	assert.equal(outB.outcome, 'needs_human_approval', `loop B outcome: ${outB.outcome}`);
	assert.equal(outB.state, 'pending_approval', `loop B state: ${outB.state}`);
	assert.ok(!('decision_token' in outB), 'loop B pending check must not carry a token');
	const preauthB = outB.preauth_id;
	log(`loop B check: outcome=needs_human_approval preauth=${preauthB}`);
	pass('loop B check: needs_human_approval, no token');

	// Claim once, before approval: must be refused not_approved_yet.
	let claimError = null;
	try {
		await run(makeContext({ operation: 'claimDecisionToken', preauthId: preauthB }, callsB));
	} catch (error) {
		claimError = error;
	}
	assert.ok(claimError, 'pre-approval claim must fail');
	assert.equal(claimError.httpCode, '409', `claim refusal httpCode: ${claimError.httpCode}`);
	assert.ok(
		claimError.message.includes('[code: not_approved_yet]'),
		`claim refusal must carry code not_approved_yet, got: ${claimError.message}`,
	);
	log(`loop B claim (pre-approval): refused httpCode=${claimError.httpCode} [code: not_approved_yet]`);
	pass('loop B claim refused with not_approved_yet before approval');

	// Owner approves, outside the node (owner-session REST).
	const login = await ownerCall('POST', '/v1/accounts/login', {
		email: OWNER_EMAIL,
		password: OWNER_PASSWORD,
	});
	assert.equal(login.status, 200, `owner login: ${login.status}`);
	const before = await ownerCall('GET', `/v1/preauthorize/${preauthB}`);
	assert.equal(before.json.state, 'pending_approval', `before approve: ${before.json.state}`);
	const approve = await ownerCall('POST', `/v1/preauthorize/${preauthB}/approve`);
	assert.equal(approve.status, 200, `approve call: ${approve.status}`);
	const after = await ownerCall('GET', `/v1/preauthorize/${preauthB}`);
	assert.equal(after.json.state, 'authorized', `after approve: ${after.json.state}`);
	log(`loop B owner approval: pending_approval -> authorized (approve HTTP ${approve.status})`);
	pass('loop B owner approval via owner-session REST');

	const [claimBItems] = await run(
		makeContext({ operation: 'claimDecisionToken', preauthId: preauthB }, callsB),
	);
	const tokenB = claimBItems[0].json.decision_token;
	assert.equal(claimBItems[0].json.claimed, true);
	assert.equal(typeof tokenB, 'string');
	assert.ok(tokenB.length > 0, 'loop B claim must deliver a token');
	secrets.add(tokenB);
	log(`loop B claim (post-approval): token delivered, tokenLen=${tokenB.length}`);
	pass('loop B claim succeeded after approval');

	const completeBParams = {
		operation: 'completePurchase',
		preauthId: preauthB,
		decisionToken: tokenB,
		completionNonce: 'n8n-live-complete-002',
		evidence: {},
	};
	assert.strictEqual(completeBParams.decisionToken, tokenB);
	const [completeBItems] = await run(makeContext(completeBParams, callsB));
	const compB = completeBItems[0].json;
	assert.equal(compB.sealed, true, 'loop B completion must seal');
	assert.equal(compB.amount_minor, 2500, `loop B sealed amount: ${compB.amount_minor}`);
	const receiptB = compB.receipt_id;
	assert.ok(receiptB, 'loop B completion must return a receipt_id');
	log(`loop B complete: sealed receipt=${receiptB} entry_seq=${compB.entry_seq}`);
	pass('loop B complete: receipt sealed, token byte-identical claim->complete');

	const [receiptBItems] = await run(
		makeContext({ operation: 'getReceipt', preauthId: preauthB, receiptId: '' }, callsB),
	);
	assert.equal(receiptBItems[0].json.state, 'completed');
	assert.equal(receiptBItems[0].json.receipt_id, receiptB);
	pass('loop B getReceipt: state completed');
	log(
		`loop B wire: ${callsB.map((c) => `${c.method} ${c.url.replace(BASE_URL, '')} -> ${c.status} (apiKeyHeader=${c.apiKeyHeaderApplied})`).join(' | ')}`,
	);

	// ------------- Server-side confirmation (owner session) --------
	for (const [label, preauth, receipt, amount] of [
		['A', preauthA, receiptA, 300],
		['B', preauthB, receiptB, 2500],
	]) {
		const p = await ownerCall('GET', `/v1/preauthorize/${preauth}`);
		assert.equal(p.status, 200, `confirm preauth ${label}: ${p.status}`);
		assert.equal(p.json.state, 'completed', `confirm preauth ${label} state: ${p.json.state}`);
		const r = await ownerCall('GET', `/v1/receipts/${receipt}`);
		assert.equal(r.status, 200, `confirm receipt ${label}: ${r.status}`);
		assert.equal(r.json.preauth_id, preauth, `confirm receipt ${label} binding`);
		assert.equal(r.json.amount_minor, amount, `confirm receipt ${label} amount`);
		log(
			`confirm loop ${label}: preauth state=completed was_allowed=${p.json.was_allowed} | receipt entry_seq=${r.json.entry_seq} amount_minor=${r.json.amount_minor} currency=${r.json.currency}`,
		);
		pass(`server-side confirmation loop ${label}`);
	}

	log('RESULT: PASS');
	console.log('RESULT: PASS');
}

main()
	.catch((error) => {
		log(`[FAIL] ${error && error.message ? error.message : error}`);
		if (error && error.stack) log(error.stack.split('\n').slice(0, 4).join('\n'));
		process.exitCode = 1;
	})
	.finally(() => logStream.end());
