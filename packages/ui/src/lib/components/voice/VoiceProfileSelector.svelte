<!--
  VoiceProfileSelector — hardware profile picker for the bundled OpenPalm
  Voice addon. Shows a <select> when multiple profiles exist, or a static
  label when only one is available.

  Used by both the admin VoiceTab and the setup wizard VoiceStep.
-->
<script lang="ts">
	import type { VoiceAddonProfile } from '$lib/api.js';

	let {
		profiles,
		selectedProfile,
		onchange,
		showDescription,
	}: {
		profiles: VoiceAddonProfile[];
		selectedProfile: string;
		onchange: (id: string) => void;
		showDescription?: boolean;
	} = $props();

	const selectedInfo = $derived(
		profiles.find((p) => p.id === selectedProfile) ?? profiles[0],
	);

	showDescription ??= true;
</script>

{#if profiles.length === 0}
	<!-- Nothing to show — caller should gate on profiles.length > 0 -->
{:else if profiles.length === 1}
	<p class="profile-single">Using {selectedInfo?.label ?? selectedInfo?.id ?? 'selected'}.</p>
{:else}
	{#if showDescription}
		<p class="profile-desc">
			Select the profile that matches your hardware. GPU profiles are auto-selected when available.
		</p>
	{/if}
	<div class="form-field">
		<label class="form-label" for="voice-profile">Profile</label>
		<select
			id="voice-profile"
			class="form-input"
			value={selectedProfile}
			onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value)}
		>
			{#each profiles as profile (profile.id)}
				<option
					value={profile.id}
					disabled={profile.available === false}
					title={profile.available === false ? (profile.reason ?? 'Not available on this host') : undefined}
				>
					{profile.label ?? profile.id}{profile.available === false ? ' — unavailable' : ''}
				</option>
			{/each}
		</select>
		{#if selectedInfo?.requires}
			<span class="field-hint">
				Requires: {selectedInfo.requires}
			</span>
		{/if}
		{#if selectedInfo?.available === false}
			<span class="field-hint field-hint--warning">
				{selectedInfo.reason ?? 'This profile is not available on the current host.'}
			</span>
		{/if}
	</div>
{/if}

<style>
	.profile-single {
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-secondary, #64748b);
		margin: 0;
	}
	.profile-desc {
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-secondary, #64748b);
		margin: 0;
	}
	.field-hint {
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-tertiary, #94a3b8);
		margin-top: 2px;
	}
	.field-hint--warning {
		color: var(--color-error, #dc2626);
	}
</style>
