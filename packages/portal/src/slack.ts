import { App, type SayFn } from '@slack/bolt';

import { GuardianChatClient } from './chat-client.js';
import { ConversationStore } from './conversations.js';
import { PortalCredentialRegistry, credentialConversationKey } from './credential-registry.js';
import { ConversationQueue } from './queue.js';
import {
	createLogger,
	errorMessage,
	isAllowed,
	parseIds,
	readSecret,
	splitMessage
} from './runtime.js';

const log = createLogger('portal:slack');

type SlackMessage = {
	user: string;
	text?: string;
	channel: string;
	ts: string;
	thread_ts?: string;
	channel_type?: string;
	subtype?: string;
	bot_id?: string;
};

export class SlackPortal {
	private readonly chat = new GuardianChatClient();
	private readonly credentials = new PortalCredentialRegistry('slack');
	private readonly conversations = new ConversationStore();
	private readonly queue = new ConversationQueue();
	private readonly allowedChannels = parseIds(Bun.env.SLACK_ALLOWED_CHANNELS);
	private readonly allowedUsers = parseIds(Bun.env.SLACK_ALLOWED_USERS);
	private readonly blockedUsers = parseIds(Bun.env.SLACK_BLOCKED_USERS);
	private readonly app = new App({
		token: readSecret('SLACK_BOT_TOKEN'),
		appToken: readSecret('SLACK_APP_TOKEN'),
		socketMode: true
	});
	private botUserId = '';

	async start(): Promise<void> {
		await this.chat.connect(this.credentials.defaultCredential());
		this.app.event('app_mention', async ({ event, say }) => {
			await this.handleMessage(event as SlackMessage, say, true);
		});
		this.app.event('message', async ({ event, say }) => {
			const message = event as SlackMessage;
			if (message.text?.includes(`<@${this.botUserId}>`)) return;
			await this.handleMessage(message, say, false);
		});
		this.app.error(async (error) => log.error('client_error', { error: errorMessage(error) }));
		await this.app.start();
		const auth = await this.app.client.auth.test();
		this.botUserId = typeof auth.user_id === 'string' ? auth.user_id : '';
		log.info('connected', { botUserId: this.botUserId });
	}

	private key(message: SlackMessage): string {
		if (message.channel_type === 'im') return `dm:${message.user}`;
		return `thread:${message.channel}:${message.thread_ts ?? message.ts}`;
	}

	private permitted(message: SlackMessage): boolean {
		return isAllowed({
			userId: message.user,
			blockedUsers: this.blockedUsers,
			scopes: [
				{ allowed: this.allowedUsers, actual: [message.user] },
				{ allowed: this.allowedChannels, actual: [message.channel] }
			]
		});
	}

	private async handleMessage(
		message: SlackMessage,
		say: SayFn,
		mentioned: boolean
	): Promise<void> {
		if (!message.user || !message.text || message.subtype || message.bot_id) return;
		if (this.botUserId && message.user === this.botUserId) return;
		const credential = this.credentials.forUser(message.user);
		const key = credentialConversationKey(credential.username, this.key(message));
		const direct = message.channel_type === 'im';
		const activeThread = Boolean(message.thread_ts && this.conversations.get('slack', key));
		if (!mentioned && !direct && !activeThread) return;

		const threadTs = message.thread_ts ?? message.ts;
		if (!this.permitted(message)) {
			await say({ text: 'You do not have permission to use this bot.', thread_ts: threadTs });
			return;
		}

		const text = message.text.replace(/<@[A-Z0-9]+>/g, '').trim();
		if (!text) return;
		if (text === '/clear' || text === '!clear') {
			this.conversations.clear('slack', key);
			await say({ text: 'Conversation cleared.', thread_ts: threadTs });
			return;
		}

		await this.queue.run(key, async () => {
			const previous = this.conversations.get('slack', key);
			try {
				const result = await this.chat.chat(text, credential, previous);
				this.conversations.set('slack', key, result.conversation);
				for (const chunk of splitMessage(result.text, 3_800)) {
					await say({ text: chunk, thread_ts: threadTs });
				}
			} catch (error) {
				log.warn('guardian_rejected', {
					userId: message.user,
					channelId: message.channel,
					error: errorMessage(error)
				});
				await say({ text: 'The request could not be completed safely.', thread_ts: threadTs });
			}
		});
	}
}
