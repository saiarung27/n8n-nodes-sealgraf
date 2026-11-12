import type {
	IDataObject,
	IExecuteFunctions,
	JsonObject,
	IHttpRequestMethods,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	buildEvidence,
	CATEGORIES,
	CATEGORY_OPTIONS,
	normalizeBaseUrl,
	optionalStr,
	parseCheckResult,
	parseClaimResult,
	parseCompleteResult,
	parsePreauthResult,
	parseReceiptResult,
	requireAmountMinor,
	requireStr,
	SealgrafApiError,
	SealgrafClient,
	SealgrafError,
	validateCurrency,
	type RawResponse,
	type SealgrafTransport,
} from './SealgrafClient';

/**
 * The Sealgraf node: one node, four operations, over Sealgraf's REST
 * API. An agent (or a workflow acting for one) checks BEFORE buying;
 * the owner approves above their limit; the completion is sealed into
 * a verifiable receipt.
 *
 * Programmatic style is deliberate: declarative routing cannot express
 * this node's contract — closed-vocabulary evidence assembly with
 * cross-field rules enforced before any HTTP call, fail-closed
 * response parsers, and the idempotent-replay rule (a replayed `allow`
 * must never be presented as a fresh permission).
 */
export class Sealgraf implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Sealgraf',
		name: 'sealgraf',
		icon: { light: 'file:sealgraf.svg', dark: 'file:sealgraf.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Check spending permission before buying, claim owner approvals, and seal verifiable receipts',
		defaults: {
			name: 'Sealgraf',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'sealgrafApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Check Permission',
						value: 'checkPermission',
						description: 'Ask Sealgraf whether a purchase is allowed before buying',
						action: 'Check permission for a purchase',
					},
					{
						name: 'Claim Decision Token',
						value: 'claimDecisionToken',
						description: 'Claim the single-use decision token after the owner approves',
						action: 'Claim a decision token',
					},
					{
						name: 'Complete Purchase',
						value: 'completePurchase',
						description: 'Report a completed purchase and seal its receipt',
						action: 'Complete a purchase and seal the receipt',
					},
					{
						name: 'Get Receipt',
						value: 'getReceipt',
						description: 'Look up a preauthorization or a sealed receipt',
						action: 'Get a receipt or preauthorization',
					},
				],
				default: 'checkPermission',
			},

			// -- Check Permission --------------------------------------
			{
				displayName: 'Category',
				name: 'category',
				type: 'options',
				required: true,
				default: 'groceries',
				displayOptions: {
					show: {
						operation: ['checkPermission'],
					},
				},
				options: CATEGORY_OPTIONS,
				description: 'What kind of purchase this is. The list is closed.',
			},
			{
				displayName: 'Amount (Minor Units)',
				name: 'amountMinor',
				type: 'number',
				required: true,
				default: 0,
				displayOptions: {
					show: {
						operation: ['checkPermission'],
					},
				},
				description:
					"Amount in the currency's minor units (for example cents): 2500 means $25.00. Must be a positive whole number.",
			},
			{
				displayName: 'Currency',
				name: 'currency',
				type: 'string',
				default: 'USD',
				displayOptions: {
					show: {
						operation: ['checkPermission'],
					},
				},
				description: 'Three-letter currency code',
			},
			{
				displayName: 'Counterparty',
				name: 'counterparty',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['checkPermission'],
					},
				},
				description: 'Who would be paid, for example the merchant name',
			},
			{
				displayName: 'Description',
				name: 'itemDescription',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['checkPermission'],
					},
				},
				description: 'What would be bought',
			},
			{
				displayName: 'Agent ID',
				name: 'agentId',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['checkPermission'],
					},
				},
				description: 'Optional agent identifier the limits are sealed under',
			},
			{
				displayName: 'Mandate ID',
				name: 'mandateId',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['checkPermission'],
					},
				},
				description: 'Optional mandate (limit set) to check against',
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['checkPermission'],
					},
				},
				description:
					'Optional. Reusing a key returns the original check instead of creating a new one. At least 8 characters when supplied. Note: a replayed allow does not re-serve the decision token.',
			},

			// -- Claim Decision Token ----------------------------------
			{
				displayName: 'Preauthorization ID',
				name: 'preauthId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['claimDecisionToken'],
					},
				},
				description: 'The preauth_id returned by Check Permission',
			},

			// -- Complete Purchase -------------------------------------
			{
				displayName: 'Preauthorization ID',
				name: 'preauthId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['completePurchase'],
					},
				},
				description: 'The preauth_id returned by Check Permission',
			},
			{
				displayName: 'Decision Token',
				name: 'decisionToken',
				type: 'string',
				typeOptions: {
					password: true,
				},
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['completePurchase'],
					},
				},
				description:
					'The single-use decision token from the check or the claim. It is spent by this call and never appears in output.',
			},
			{
				displayName: 'Completion Nonce',
				name: 'completionNonce',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['completePurchase'],
					},
				},
				description:
					'Idempotency nonce for this completion. Leave empty to generate one from the workflow execution ID and the preauthorization ID.',
			},
			{
				displayName: 'Completion Evidence',
				name: 'evidence',
				type: 'collection',
				placeholder: 'Add Evidence Field',
				default: {},
				displayOptions: {
					show: {
						operation: ['completePurchase'],
					},
				},
				description:
					'Optional facts about the completed purchase, sealed into the receipt. Only the fields you add are sent; the key set is closed.',
				options: [
					{
						displayName: 'Completed Amount (Minor Units)',
						name: 'completedAmountMinor',
						type: 'number',
						default: 0,
						description: 'The amount actually completed, in minor units',
					},
					{
						displayName: 'Counterparty Receipt Ref',
						name: 'counterpartyReceiptRef',
						type: 'string',
						default: '',
						description: "The merchant's own order or receipt reference",
					},
					{
						displayName: 'Note',
						name: 'note',
						type: 'string',
						default: '',
						description: 'Free-text note sealed with the receipt',
					},
					{
						displayName: 'Payment Charged Amount (Minor Units)',
						name: 'paymentChargedAmountMinor',
						type: 'number',
						default: 0,
						description:
							'The amount the rail actually charged, in minor units. Requires Payment Currency.',
					},
					{
						displayName: 'Payment Currency',
						name: 'paymentCurrency',
						type: 'string',
						default: '',
						placeholder: 'USD',
						description: 'Three-letter currency code of the charged amount',
					},
					{
						displayName: 'Payment Instrument Label',
						name: 'paymentInstrumentLabel',
						type: 'string',
						default: '',
						description: 'For example the card brand or wallet name',
					},
					{
						displayName: 'Payment Instrument Last 4',
						name: 'paymentInstrumentLast4',
						type: 'string',
						default: '',
						description: 'Exactly four digits, as a string',
					},
					{
						displayName: 'Payment Provenance',
						name: 'paymentProvenance',
						type: 'options',
						default: 'browser_checkout',
						options: [
							{ name: 'Browser Checkout', value: 'browser_checkout' },
							{ name: 'Merchant Confirmation', value: 'merchant_confirmation' },
							{ name: 'Rail API', value: 'rail_api' },
						],
						description: 'How the payment outcome is known',
					},
					{
						displayName: 'Payment Rail',
						name: 'paymentRail',
						type: 'options',
						default: 'link_stripe',
						options: [
							{ name: 'Card on Merchant Site', value: 'card_on_merchant' },
							{ name: 'Other', value: 'other' },
							{ name: 'PayPal', value: 'paypal' },
							{ name: 'Stripe API', value: 'stripe_api' },
							{ name: 'Stripe Link', value: 'link_stripe' },
						],
						description: 'How the payment was made',
					},
					{
						displayName: 'Payment Rail Label',
						name: 'paymentRailLabel',
						type: 'string',
						default: '',
						description: "Required when Payment Rail is 'Other': name the rail",
					},
					{
						displayName: 'Payment Rail Ref Kind',
						name: 'paymentRailRefKind',
						type: 'options',
						default: 'charge',
						options: [
							{ name: 'Charge', value: 'charge' },
							{ name: 'Other', value: 'other' },
							{ name: 'Payment Intent', value: 'payment_intent' },
							{ name: 'PayPal Transaction', value: 'paypal_transaction' },
						],
						description:
							'Kind of the rail reference. Must be supplied together with Payment Rail Ref Value.',
					},
					{
						displayName: 'Payment Rail Ref Value',
						name: 'paymentRailRefValue',
						type: 'string',
						default: '',
						description: 'The rail reference itself, for example a charge ID',
					},
					{
						displayName: 'Payment Virtual Last 4',
						name: 'paymentVirtualLast4',
						type: 'string',
						default: '',
						description: 'Last four digits of a virtual card number, if one was used',
					},
				],
			},

			// -- Get Receipt -------------------------------------------
			{
				displayName: 'Preauthorization ID',
				name: 'preauthId',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['getReceipt'],
					},
				},
				description:
					'Look up by preauthorization: returns the check, its decision, and its receipt ID once completed. Provide exactly one of Preauthorization ID or Receipt ID.',
			},
			{
				displayName: 'Receipt ID',
				name: 'receiptId',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['getReceipt'],
					},
				},
				description:
					'Look up by sealed receipt ID. Provide exactly one of Preauthorization ID or Receipt ID.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('sealgrafApi');
		const apiKey = typeof credentials.apiKey === 'string' ? credentials.apiKey.trim() : '';
		if (!apiKey) {
			throw new NodeOperationError(
				this.getNode(),
				'Sealgraf API key is missing. Set the agent-scope API key in the Sealgraf credentials.',
			);
		}
		let baseUrl: string;
		try {
			baseUrl = normalizeBaseUrl(
				typeof credentials.baseUrl === 'string' ? credentials.baseUrl : undefined,
			);
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error as Error);
		}

		// The transport rides n8n's authenticated request helper, so the
		// credentials type's generic authenticate applies the X-API-Key
		// header. Status codes are handled by the client (mirroring the
		// reference client), so HTTP errors come back as data here;
		// only transport-level failures throw, and they fail closed.
		const transport: SealgrafTransport = async (request): Promise<RawResponse> => {
			let response: { statusCode: number; body: unknown };
			try {
				response = (await this.helpers.httpRequestWithAuthentication.call(this, 'sealgrafApi', {
					method: request.method as IHttpRequestMethods,
					url: `${baseUrl}${request.path}`,
					...(request.body !== undefined ? { body: request.body as IDataObject } : {}),
					...(request.qs !== undefined ? { qs: request.qs as IDataObject } : {}),
					headers: {
						'Content-Type': 'application/json',
						'User-Agent': 'n8n-nodes-sealgraf/0.1.2',
					},
					timeout: 20000,
					returnFullResponse: true,
					ignoreHttpStatusErrors: true,
				})) as { statusCode: number; body: unknown };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// The transport throws n8n-native errors directly (n8n's
				// verification rules require NodeApiError/NodeOperationError
				// from node code). The shared client passes n8n-native
				// errors through unchanged, so the fail-closed message —
				// and the behavior — is identical to the reference client.
				if (/timed out|timeout|etimedout/i.test(message)) {
					throw new NodeOperationError(
						this.getNode(),
						`Sealgraf request timed out (${request.method} ${request.path}). ` +
							'Failing closed: no permission was granted.',
					);
				}
				throw new NodeOperationError(
					this.getNode(),
					`Sealgraf request failed (${request.method} ${request.path}): ${message}. ` +
						'Failing closed: no permission was granted.',
				);
			}
			let data: unknown = response.body;
			if (typeof data === 'string') {
				try {
					data = JSON.parse(data);
				} catch {
					// Not JSON: keep the raw text so the client can fail
					// closed with it (error detail on non-2xx, malformed
					// body on 2xx), exactly like the reference client.
				}
			}
			return { status: response.statusCode, data };
		};
		const client = new SealgrafClient(transport);

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				let result: Record<string, unknown>;

				if (operation === 'checkPermission') {
					result = await runCheckPermission(this, client, itemIndex);
				} else if (operation === 'claimDecisionToken') {
					const preauthId = requireStr(
						this.getNodeParameter('preauthId', itemIndex, ''),
						'preauth_id',
					);
					result = parseClaimResult(await client.claimDecisionToken(preauthId), preauthId);
				} else if (operation === 'completePurchase') {
					result = await runCompletePurchase(this, client, itemIndex);
				} else if (operation === 'getReceipt') {
					result = await runGetReceipt(this, client, itemIndex);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
				}

				returnData.push({ json: result as IDataObject, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error instanceof Error ? error.message : String(error),
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof SealgrafApiError) {
					// n8n-workflow 2.x NodeApiError takes the API's error
					// body object, not an Error. The full client message
					// (with the server's stable refusal code) rides in
					// `message`, which NodeApiError prefers over `detail`.
					throw new NodeApiError(
						this.getNode(),
						{ ...(error.responseBody ?? {}), message: error.message } as JsonObject,
						{ httpCode: String(error.statusCode), message: error.message, itemIndex },
					);
				}
				if (error instanceof SealgrafError) {
					throw new NodeOperationError(this.getNode(), error, { itemIndex });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}

async function runCheckPermission(
	ctx: IExecuteFunctions,
	client: SealgrafClient,
	itemIndex: number,
): Promise<IDataObject> {
	const category = optionalStr(ctx.getNodeParameter('category', itemIndex, ''));
	if (category === undefined) {
		throw new NodeOperationError(ctx.getNode(), 'category is required.');
	}
	if (!(CATEGORIES as readonly string[]).includes(category)) {
		throw new NodeOperationError(
			ctx.getNode(),
			`category must be one of: ${CATEGORIES.join(', ')}; got '${category}'.`,
		);
	}
	const amountMinor = requireAmountMinor(
		ctx.getNodeParameter('amountMinor', itemIndex),
		'amount_minor',
	);
	const currency = validateCurrency(ctx.getNodeParameter('currency', itemIndex, ''));
	const idempotencyKey = optionalStr(ctx.getNodeParameter('idempotencyKey', itemIndex, ''));
	if (idempotencyKey !== undefined && idempotencyKey.length < 8) {
		throw new NodeOperationError(
			ctx.getNode(),
			'idempotency_key must be at least 8 characters ' + '(the Sealgraf API refuses shorter keys).',
		);
	}
	const data = await client.checkPermission({
		category,
		amountMinor,
		currency,
		counterparty: optionalStr(ctx.getNodeParameter('counterparty', itemIndex, '')),
		description: optionalStr(ctx.getNodeParameter('itemDescription', itemIndex, '')),
		agentId: optionalStr(ctx.getNodeParameter('agentId', itemIndex, '')),
		mandateId: optionalStr(ctx.getNodeParameter('mandateId', itemIndex, '')),
		idempotencyKey,
	});
	return parseCheckResult(data) as IDataObject;
}

async function runCompletePurchase(
	ctx: IExecuteFunctions,
	client: SealgrafClient,
	itemIndex: number,
): Promise<IDataObject> {
	const preauthId = requireStr(ctx.getNodeParameter('preauthId', itemIndex, ''), 'preauth_id');
	const decisionToken = requireStr(
		ctx.getNodeParameter('decisionToken', itemIndex, ''),
		'decision_token',
	);
	let completionNonce = optionalStr(ctx.getNodeParameter('completionNonce', itemIndex, ''));
	if (completionNonce === undefined) {
		// Node-generated idempotency: stable within one workflow
		// execution (a re-run of this node in the same execution
		// re-sends the same completion), distinct across executions.
		completionNonce = `n8n-${ctx.getExecutionId()}-${preauthId}`;
	}
	// Evidence rules are enforced here, before any HTTP call.
	const evidence = buildEvidence(
		ctx.getNodeParameter('evidence', itemIndex, {}) as Record<string, unknown>,
	);
	const data = await client.completePurchase(preauthId, {
		decisionToken,
		completionNonce,
		evidence,
	});
	return parseCompleteResult(data) as IDataObject;
}

async function runGetReceipt(
	ctx: IExecuteFunctions,
	client: SealgrafClient,
	itemIndex: number,
): Promise<IDataObject> {
	const preauthId = optionalStr(ctx.getNodeParameter('preauthId', itemIndex, ''));
	const receiptId = optionalStr(ctx.getNodeParameter('receiptId', itemIndex, ''));
	if ((preauthId === undefined) === (receiptId === undefined)) {
		throw new NodeOperationError(ctx.getNode(), 'Provide exactly one of preauth_id or receipt_id.');
	}
	if (receiptId !== undefined) {
		return parseReceiptResult(await client.getReceipt(receiptId)) as IDataObject;
	}
	return parsePreauthResult(await client.getPreauth(preauthId as string)) as IDataObject;
}
