<script lang="ts">
	import { getSetupState } from '$lib/stores/setup.svelte';

	interface Props {
		error: string;
	}

	let { error }: Props = $props();

	const state = $derived(getSetupState());
	const enabledChannels = $derived(state?.enabledChannels ?? []);

	interface ChannelDef {
		id: string;
		name: string;
		desc: string;
		fields: Array<{
			key: string;
			label: string;
			type: string;
			required: boolean;
			helpText: string;
		}>;
	}

	const CHANNELS: ChannelDef[] = [
		{
			id: 'channel-chat',
			name: 'Chat',
			desc: 'Chat with your assistant through the built-in web interface',
			fields: [
				{
					key: 'CHAT_INBOUND_TOKEN',
					label: 'Inbound Token',
					type: 'password',
					required: false,
					helpText: 'Token for authenticating incoming chat messages'
				}
			]
		},
		{
			id: 'channel-discord',
			name: 'Discord',
			desc: 'Connect your assistant to a Discord server',
			fields: [
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
			]
		},
		{
			id: 'channel-voice',
			name: 'Voice',
			desc: 'Talk to your assistant using voice',
			fields: []
		},
		{
			id: 'channel-telegram',
			name: 'Telegram',
			desc: 'Connect your assistant to Telegram',
			fields: [
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
		}
	];

	function isChecked(channelId: string): boolean {
		return enabledChannels.includes(channelId);
	}
</script>

<p>
	Choose how you want to talk to your assistant. Check any channels you want to enable. You can
	skip this and add channels later from the admin dashboard.
</p>

{#if error}
	<div class="wiz-error visible">{error}</div>
{/if}

{#each CHANNELS as channel}
	{@const checked = isChecked(channel.id)}
	<div class="channel-section {checked ? 'enabled' : ''}">
		<label style="display:flex;gap:0.7rem;align-items:start;cursor:pointer">
			<input
				type="checkbox"
				class="wiz-ch"
				value={channel.id}
				checked={checked}
				style="width:auto;margin-top:4px"
			/>
			<div>
				<strong>{channel.name}</strong>
				<div class="muted" style="font-size:13px">{channel.desc}</div>
			</div>
		</label>
		{#if channel.fields.length > 0}
			<div class="channel-fields" id="ch-fields-{channel.id}" style={checked ? '' : 'display:none'}>
				{#each channel.fields as field}
					<label style="display:block;margin:0.4rem 0 0.2rem;font-size:13px">
						{field.label}{field.required ? ' *' : ''}
					</label>
					<input
						class="wiz-ch-field"
						data-channel={channel.id}
						data-key={field.key}
						type={field.type}
						placeholder={field.helpText}
						value=""
					/>
				{/each}
			</div>
		{/if}
	</div>
{/each}
