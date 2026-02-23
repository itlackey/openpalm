<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import QuickLinks from '$lib/components/QuickLinks.svelte';
	import AdminAuth from '$lib/components/AdminAuth.svelte';
	import StackEditor from '$lib/components/StackEditor.svelte';
	import SecretsEditor from '$lib/components/SecretsEditor.svelte';
	import HealthStatus from '$lib/components/HealthStatus.svelte';
	import SetupWizard from '$lib/components/SetupWizard.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import {
		isWizardOpen,
		setWizardOpen,
		setSetupState,
		getSetupState
	} from '$lib/stores/setup.svelte';

	let showWizard = $derived(isWizardOpen());

	async function checkSetup() {
		const r = await api('/setup/status');
		if (!r.ok) return;
		setSetupState(r.data);
		if (!r.data.completed) {
			setWizardOpen(true);
		}
	}

	function runSetup() {
		setWizardOpen(true);
	}

	onMount(() => {
		checkSetup();
	});
</script>

<h2>Dashboard</h2>

<QuickLinks />
<AdminAuth />
<StackEditor />
<SecretsEditor />

{#if getSetupState()?.completed}
	<ProfileCard />
{/if}

<div class="card">
	<h3>Setup Wizard</h3>
	<p class="muted" style="font-size:13px">
		Re-run the initial setup wizard to reconfigure channels, API keys, and access scope.
	</p>
	<button class="btn-secondary" onclick={runSetup}>Run Setup Wizard</button>
</div>

<HealthStatus />

{#if showWizard}
	<SetupWizard onclose={() => setWizardOpen(false)} />
{/if}
