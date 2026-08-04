<script lang="ts">
	import { pwaInstallService } from '$lib/pwa-install-state.svelte.js';
	import { TLS_GUIDE_URL } from '$lib/connections/url-policy.js';

	/* Shown with the insecure-origin explanation so the address that blocks the
	 * install is the one the person is actually looking at. */
	const currentOrigin = typeof window === 'undefined' ? '' : window.location.origin;
</script>

<div class="install-affordance" aria-live="polite">
	{#if pwaInstallService.status === 'available' || pwaInstallService.status === 'prompting'}
		<button
			type="button"
			class="btn btn-secondary"
			onclick={() => pwaInstallService.prompt()}
			disabled={pwaInstallService.status === 'prompting'}
		>
			{pwaInstallService.status === 'prompting' ? 'Opening install prompt…' : 'Install OpenPalm'}
		</button>
	{:else if pwaInstallService.status === 'installed'}
		<p>OpenPalm is installed on this device.</p>
	{:else if pwaInstallService.status === 'accepted'}
		<p>Installation accepted. OpenPalm will appear with your apps.</p>
	{:else if pwaInstallService.status === 'dismissed'}
		<p>Install dismissed. You can install later from your browser menu.</p>
	{:else if pwaInstallService.status === 'ios'}
		<p>In Safari, tap Share, then <strong>Add to Home Screen</strong>.</p>
	{:else if pwaInstallService.status === 'insecure-origin'}
		<p>
			Browsers only install apps from a secure address, and this page is on
			{#if currentOrigin}<code>{currentOrigin}</code>{:else}a plain HTTP address{/if}. Open
			OpenPalm over <strong>https://</strong>, or on this computer at
			<code>http://localhost</code>, and the install option appears.
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external URL supplied by the connection policy -->
			<a href={TLS_GUIDE_URL} target="_blank" rel="noopener noreferrer">Set up HTTPS</a>
		</p>
	{:else}
		<p>Use your browser's install option when it is available.</p>
	{/if}
</div>

<style>
	.install-affordance {
		display: flex;
		align-items: flex-start;
	}
	p {
		margin: 0;
		color: var(--s-ink-3);
		/* An origin is one unbreakable token; let it wrap on a phone. */
		overflow-wrap: anywhere;
	}
	code {
		font-family: var(--s-font-mono);
	}
	a {
		color: var(--s-ink-2);
	}
</style>
