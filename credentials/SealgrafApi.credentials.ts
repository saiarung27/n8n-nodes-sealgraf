import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Sealgraf credentials: an agent-scope API key, sent as the
 * `X-API-Key` header on every request (the node's HTTP calls go
 * through `httpRequestWithAuthentication`, which applies the generic
 * `authenticate` below; the same block serves the HTTP Request node
 * and declarative consumers).
 *
 * The test request is the lightest authenticated read an agent key may
 * make — `GET /v1/receipts?limit=1`. `GET /v1/mandates` is NOT used:
 * production refuses agent-scope keys there (admin-gated).
 */
export class SealgrafApi implements ICredentialType {
	name = 'sealgrafApi';
	displayName = 'Sealgraf API';
	icon: Icon = {
		light: 'file:../nodes/Sealgraf/sealgraf.svg',
		dark: 'file:../nodes/Sealgraf/sealgraf.svg',
	};
	documentationUrl = 'https://sealgraf.com';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://sealgraf.com',
			placeholder: 'https://sealgraf.com',
			description:
				'Base URL of the Sealgraf service. Leave the default for the hosted service; change it only for a self-hosted or test deployment.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description:
				'Agent-scope Sealgraf API key. It is sent as the X-API-Key header and never appears in node output.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/receipts',
			method: 'GET',
			qs: {
				limit: 1,
			},
		},
	};
}
