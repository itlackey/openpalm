<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	interface Props {
		oncontinue: () => void;
	}

	let { oncontinue }: Props = $props();

	let statusText = $state('Starting services...');
	let ready = $state(false);
	let timedOut = $state(false);
	let serviceStatus = $state<Record<string, { ok: boolean; time?: string }>>({});

	async function pollUntilReady() {
		// Poll for up to 60 seconds (60 iterations × 1s). If any non-admin service
		// is still unreachable after the first few attempts we continue polling, but
		// we give up at 60s so the user is never stuck indefinitely.
		const MAX_POLLS = 60;
		// Early-exit: if after 5 polls no non-admin service has come up at all,
		// we assume Docker is not running yet and skip straight to the timeout state.
		const FAST_FAIL_AFTER = 5;

		for (let i = 0; i < MAX_POLLS; i++) {
			const r = await api('/setup/health-check');
			if (r.ok) {
				const services = r.data?.services || {};
				serviceStatus = Object.fromEntries(
					Object.entries(services).map(([name, s]) => [
						name,
						{ ok: !!(s as any)?.ok, time: (s as any)?.time }
					])
				);
				const allOk = Object.values(services).every((s) => (s as any)?.ok);
				if (allOk) {
					ready = true;
					statusText = 'Everything is ready!';
					return;
				}
				// Fast-fail: if after FAST_FAIL_AFTER polls no non-admin service
				// has responded at all, Docker isn't running — stop waiting.
				if (i >= FAST_FAIL_AFTER - 1) {
					const nonAdminServices = Object.entries(services).filter(([name]) => name !== 'admin');
					const anyNonAdminUp = nonAdminServices.some(([, s]) => (s as any)?.ok);
					if (!anyNonAdminUp && nonAdminServices.length > 0) {
						timedOut = true;
						statusText = 'Some services are still starting.';
						return;
					}
				}
			}
			statusText = `Starting services... (${i + 1})`;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		timedOut = true;
		statusText = 'Some services are still starting.';
	}

	onMount(() => {
		pollUntilReady();
	});
</script>

<p>Finalizing setup and starting your assistant...</p>

<div>
	<p class="muted">{statusText}</p>
	{#if !ready && !timedOut && Object.keys(serviceStatus).length > 0}
		<ul style="margin:0.4rem 0; padding-left:1.2rem; font-size:13px">
			{#each Object.entries(serviceStatus) as [name, s]}
				<li style="color: {s.ok ? 'var(--green, green)' : 'var(--muted, #888)'}">
					{name} — {s.ok ? 'ready' : 'starting...'}
				</li>
			{/each}
		</ul>
	{/if}
	{#if ready}
		<button onclick={oncontinue}>Continue to Admin</button>
	{:else if timedOut}
		<div style="margin:0.5rem 0">
			<p>Some services took too long to start:</p>
			<ul style="margin:0.4rem 0; padding-left:1.2rem">
				{#each Object.entries(serviceStatus) as [name, s]}
					<li style="color: {s.ok ? 'var(--green, green)' : 'var(--red, red)'}">
						{name} — {s.ok ? 'ready' : 'not ready'}
					</li>
				{/each}
			</ul>
			<p class="muted" style="font-size:13px">
				Check your API key is correct, then run <code>openpalm logs</code> for details.
			</p>
		</div>
		<button class="btn-secondary" onclick={oncontinue}>Continue to Admin</button>
	{/if}
</div>
