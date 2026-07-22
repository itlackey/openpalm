<script lang="ts">
	import { pwaInstallService } from '$lib/pwa-install-state.svelte.js';
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
	}
</style>
