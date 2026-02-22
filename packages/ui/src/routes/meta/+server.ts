import { json } from '$lib/server/json';
import { BUILTIN_CHANNELS } from '@openpalm/lib/assets/channels/index';
import { CoreSecretRequirements } from '$lib/server/init';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const channelServiceNames: Record<string, { label: string; description: string }> = {};
	for (const [key, def] of Object.entries(BUILTIN_CHANNELS)) {
		channelServiceNames[`channel-${key}`] = {
			label: `${def.name} Channel`,
			description: `${def.name} adapter for OpenPalm`
		};
	}

	return json(200, {
		serviceNames: {
			gateway: {
				label: 'Message Router',
				description: 'Routes messages between channels and your assistant'
			},
			assistant: { label: 'AI Assistant', description: 'The core assistant engine' },
			openmemory: {
				label: 'Memory',
				description: 'Stores conversation history and context'
			},
			'openmemory-ui': {
				label: 'Memory Dashboard',
				description: 'Visual interface for memory data'
			},
			admin: { label: 'Admin Panel', description: 'This management interface' },
			...channelServiceNames,
			caddy: { label: 'Web Server', description: 'Handles secure connections' }
		},
		channelFields: {
			'channel-chat': [
				{
					key: 'CHAT_INBOUND_TOKEN',
					label: 'Inbound Token',
					type: 'password',
					required: false,
					helpText: 'Token for authenticating incoming chat messages'
				}
			],
			'channel-discord': [
				{
					key: 'DISCORD_BOT_TOKEN',
					label: 'Bot Token',
					type: 'password',
					required: true,
					helpText: 'Create a bot at discord.com/developers and copy the token'
				},
				{
					key: 'DISCORD_PUBLIC_KEY',
					label: 'Public Key',
					type: 'text',
					required: true,
					helpText: 'Found on the same page as your bot token'
				}
			],
			'channel-voice': [],
			'channel-telegram': [
				{
					key: 'TELEGRAM_BOT_TOKEN',
					label: 'Bot Token',
					type: 'password',
					required: true,
					helpText: 'Get a bot token from @BotFather on Telegram'
				},
				{
					key: 'TELEGRAM_WEBHOOK_SECRET',
					label: 'Webhook Secret',
					type: 'password',
					required: false,
					helpText: 'A secret string to verify incoming webhook requests'
				}
			]
		},
		builtInChannels: BUILTIN_CHANNELS,
		requiredCoreSecrets: CoreSecretRequirements
	});
};
