<script lang="ts">
	import { getSetupState } from '$lib/stores/setup.svelte';
	import { BUILTIN_CHANNELS } from '@openpalm/lib/assets/channels/index';
	import type { EnvVarDef } from '@openpalm/lib/shared/snippet-types';

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

	/** Map EnvVarDef field type to HTML input type. */
	function inputType(envType: EnvVarDef['type']): string {
		switch (envType) {
			case 'secret':
				return 'password';
			case 'number':
				return 'number';
			case 'email':
				return 'email';
			case 'url':
				return 'url';
			default:
				return 'text';
		}
	}

	/** Build ChannelDef list from YAML-driven env metadata. */
	const CHANNELS: ChannelDef[] = Object.entries(BUILTIN_CHANNELS).map(([key, def]) => ({
		id: `channel-${key}`,
		name: def.name,
		desc: def.description ?? '',
		fields: (def.env ?? [])
			.filter((e) => e.name !== def.sharedSecretEnv)
			.map((e) => ({
				key: e.name,
				label: e.label,
				type: inputType(e.type),
				required: e.required,
				helpText: e.description ?? ''
			}))
	}));

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
				{#if channel.desc}
					<div class="muted" style="font-size:13px">{channel.desc}</div>
				{/if}
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
