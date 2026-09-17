import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { PortalCredential } from './credential-registry.js';

type ChatResult = { conversation: string; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return '';
	return content
		.map((item) => {
			const value = asRecord(item);
			return value?.type === 'text' && typeof value.text === 'string' ? value.text : '';
		})
		.filter(Boolean)
		.join('\n');
}

function interactionText(structured: Record<string, unknown>): string {
	const interactions = Array.isArray(structured.interactions) ? structured.interactions : [];
	const lines = interactions.flatMap((entry) => {
		const interaction = asRecord(entry);
		if (interaction?.kind === 'question' && Array.isArray(interaction.questions)) {
			return interaction.questions.map((question) => {
				const value = asRecord(question);
				const text = typeof value?.question === 'string' ? value.question : 'Agent input required';
				const options = Array.isArray(value?.options)
					? value.options
							.map((option) => asRecord(option)?.label)
							.filter((label): label is string => typeof label === 'string')
					: [];
				return options.length ? `${text}\nOptions: ${options.join(', ')}` : text;
			});
		}
		if (interaction?.kind === 'permission') {
			const permission =
				typeof interaction.permission === 'string' ? interaction.permission : 'privileged action';
			return [
				`The agent is waiting for permission to perform ${permission}. Use a full MCP client to approve or reject it explicitly.`
			];
		}
		return [];
	});
	return lines.join('\n\n') || 'The agent is waiting for input. Use an MCP client to respond.';
}

export class GuardianChatClient {
	private readonly connections = new Map<
		string,
		{ key: string; client?: Client; connecting?: Promise<Client> }
	>();

	private async createClient(token: string): Promise<Client> {
		const url = new URL(Bun.env.MCP_SERVER_URL ?? 'http://guardian:8080/mcp');
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error('MCP_SERVER_URL must use http or https');
		}
		const transport = new StreamableHTTPClientTransport(url, {
			authProvider: { token: async () => token }
		});
		const client = new Client(
			{ name: 'openpalm-portal', version: '2' },
			{ capabilities: {}, versionNegotiation: { mode: 'auto' } }
		);
		await client.connect(transport, { timeout: 15_000 });
		return client;
	}

	private async clientFor(credential: PortalCredential): Promise<Client> {
		let slot = this.connections.get(credential.username);
		if (slot && slot.key !== credential.key) {
			this.connections.delete(credential.username);
			const oldClient = slot.client ?? (await slot.connecting?.catch(() => undefined));
			if (oldClient) await oldClient.close().catch(() => {});
			slot = undefined;
		}
		if (slot?.client) return slot.client;
		if (slot?.connecting) return slot.connecting;
		const next: { key: string; client?: Client; connecting?: Promise<Client> } = {
			key: credential.key
		};
		next.connecting = this.createClient(credential.key);
		this.connections.set(credential.username, next);
		try {
			next.client = await next.connecting;
			next.connecting = undefined;
			return next.client;
		} catch (error) {
			if (this.connections.get(credential.username) === next) {
				this.connections.delete(credential.username);
			}
			throw error;
		}
	}

	async connect(credential: PortalCredential): Promise<void> {
		await this.clientFor(credential);
	}

	private async call(name: string, args: Record<string, unknown>, credential: PortalCredential) {
		const client = await this.clientFor(credential);
		return client
			.callTool(
				{ name, arguments: args },
				{
					timeout: 45_000,
					maxTotalTimeout: 45_000,
					resetTimeoutOnProgress: true,
					onprogress: () => {}
				}
			)
			.catch(async (error: unknown) => {
				const slot = this.connections.get(credential.username);
				if (slot?.client === client) this.connections.delete(credential.username);
				await client.close().catch(() => {});
				throw error;
			});
	}

	async chat(
		message: string,
		credential: PortalCredential,
		conversation?: string
	): Promise<ChatResult> {
		let result = await this.call(
			'openpalm.agent.run',
			{
				message,
				...(conversation ? { session: conversation } : {}),
				waitMs: 30_000
			},
			credential
		);
		let structured = asRecord(result.structuredContent);
		const stopAt = Date.now() + 150_000;
		while (!result.isError && structured?.status === 'running' && Date.now() < stopAt) {
			if (typeof structured.job !== 'string') break;
			result = await this.call(
				'openpalm.job.get',
				{
					job: structured.job,
					waitMs: 30_000
				},
				credential
			);
			structured = asRecord(result.structuredContent);
		}

		if (result.isError || typeof structured?.session !== 'string') {
			throw new Error(
				(contentText(result.content) || 'Guardian rejected the request').slice(0, 300)
			);
		}
		if (structured.status === 'input_required') {
			return {
				conversation: structured.session,
				text: interactionText(structured).slice(0, 100_000)
			};
		}
		if (structured.status === 'running') {
			const job = typeof structured.job === 'string' ? structured.job : '(unavailable)';
			return {
				conversation: structured.session,
				text: `The agent is still working. Connect with a full MCP client to poll or cancel this job: ${job}`
			};
		}
		if (structured.status === 'failed') {
			throw new Error(
				(typeof structured.error === 'string' ? structured.error : 'The agent run failed.').slice(
					0,
					300
				)
			);
		}
		const text =
			typeof structured.text === 'string' ? structured.text : contentText(result.content);
		return {
			conversation: structured.session,
			text: (text || '(no text response)').slice(0, 100_000)
		};
	}

	async close(): Promise<void> {
		const slots = [...this.connections.values()];
		this.connections.clear();
		await Promise.all(
			slots.map(async (slot) => {
				const client = slot.client ?? (await slot.connecting?.catch(() => undefined));
				if (client) await client.close().catch(() => {});
			})
		);
	}
}
