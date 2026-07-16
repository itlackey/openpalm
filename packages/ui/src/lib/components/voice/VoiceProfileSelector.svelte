<!--
  VoiceProfileSelector — hardware profile picker for the bundled OpenPalm
  Voice addon. Shows a <select> when multiple profiles exist, or a static
  label when only one is available.

  Used by the Capabilities (Add-ons) voice drawer and the setup wizard.
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
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-2);
		margin: 0;
	}
	.profile-desc {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-2);
		margin: 0;
	}
	.field-hint {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		margin-top: var(--s-sp-1);
	}
	.field-hint--warning {
		color: var(--s-seal);
	}

	/* Stillness overrides for global form utilities used inside this component */
	:global(.engine-section .form-field) {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-1);
	}
	:global(.engine-section .form-label) {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: var(--s-track-label);
		color: var(--s-ink-3);
	}
	:global(.engine-section .form-input) {
		width: 100%;
		height: auto;
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		padding: 0.4em 0.6em;
		background: none;
		color: var(--s-ink-2);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		box-shadow: none;
	}
	:global(.engine-section .form-input:focus) {
		outline: none;
		border-color: var(--s-seal);
		box-shadow: none;
	}
	:global(.engine-section .form-input:focus-visible) {
		outline: none;
		border-color: var(--s-seal);
	}
</style>
