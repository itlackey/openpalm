import { Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js';

import { GuardianChatClient } from './chat-client.js';
import { ConversationStore } from './conversations.js';
import { ConversationQueue } from './queue.js';
import {
	createLogger,
	errorMessage,
	isAllowed,
	parseIds,
	readSecret,
	splitMessage
} from './runtime.js';

const log = createLogger('portal:discord');

export class DiscordPortal {
	private readonly client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessages
		],
		partials: [Partials.Channel, Partials.Message]
	});
	private readonly chat = new GuardianChatClient();
	private readonly conversations = new ConversationStore();
	private readonly queue = new ConversationQueue();
	private readonly allowedGuilds = parseIds(Bun.env.DISCORD_ALLOWED_GUILDS);
	private readonly allowedRoles = parseIds(Bun.env.DISCORD_ALLOWED_ROLES);
	private readonly allowedUsers = parseIds(Bun.env.DISCORD_ALLOWED_USERS);
	private readonly blockedUsers = parseIds(Bun.env.DISCORD_BLOCKED_USERS);

	async start(): Promise<void> {
		await this.chat.connect();
		this.client.on(Events.Error, (error) =>
			log.error('client_error', { error: errorMessage(error) })
		);
		this.client.on(Events.MessageCreate, (message) => {
			void this.onMessage(message).catch((error) => {
				log.error('message_failed', { error: errorMessage(error), messageId: message.id });
			});
		});
		const ready = new Promise<void>((resolve) => {
			this.client.once(Events.ClientReady, (client) => {
				log.info('connected', { bot: client.user.tag, guilds: client.guilds.cache.size });
				resolve();
			});
		});
		await this.client.login(readSecret('DISCORD_BOT_TOKEN'));
		await ready;
	}

	private conversationKey(message: Message): string {
		if (!message.guildId) return `dm:${message.author.id}`;
		if (message.channel.isThread()) return `thread:${message.channel.id}`;
		return `channel:${message.channel.id}:user:${message.author.id}`;
	}

	private permitted(message: Message): boolean {
		return isAllowed({
			userId: message.author.id,
			blockedUsers: this.blockedUsers,
			scopes: [
				{ allowed: this.allowedUsers, actual: [message.author.id] },
				{ allowed: this.allowedGuilds, actual: message.guildId ? [message.guildId] : [] },
				{
					allowed: this.allowedRoles,
					actual: message.member?.roles.cache.map((role) => role.id) ?? []
				}
			]
		});
	}

	private async onMessage(message: Message): Promise<void> {
		if (message.author.bot || !this.client.user) return;
		const key = this.conversationKey(message);
		const isDirectMessage = message.guildId === null;
		const isMention = message.mentions.has(this.client.user.id);
		const isActiveThread =
			message.channel.isThread() && Boolean(this.conversations.get('discord', key));
		if (!isDirectMessage && !isMention && !isActiveThread) return;

		if (!this.permitted(message)) {
			await message.reply('You do not have permission to use this bot.');
			return;
		}

		const text = message.content.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
		if (!text) return;
		if (text === '/clear' || text === '!clear') {
			this.conversations.clear('discord', key);
			await message.reply('Conversation cleared.');
			return;
		}

		await this.queue.run(key, async () => {
			if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {});
			const previous = this.conversations.get('discord', key);
			try {
				const result = await this.chat.chat(text, previous);
				this.conversations.set('discord', key, result.conversation);
				for (const chunk of splitMessage(result.text, 1_900)) await message.reply(chunk);
			} catch (error) {
				log.warn('guardian_rejected', {
					userId: message.author.id,
					guildId: message.guildId,
					error: errorMessage(error)
				});
				await message.reply('The request could not be completed safely.');
			}
		});
	}
}
