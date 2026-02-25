<script lang="ts">
	import { api } from '$lib/api';
	import { setAdminToken } from '$lib/stores/auth.svelte';
	import { getWizardStep, setWizardStep, getSetupState } from '$lib/stores/setup.svelte';
	import WizardSteps from './WizardSteps.svelte';
	import WelcomeStep from './WelcomeStep.svelte';
	import ProfileStep from './ProfileStep.svelte';
	import ProvidersStep from './ProvidersStep.svelte';
	import SecurityStep from './SecurityStep.svelte';
	import ChannelsStep from './ChannelsStep.svelte';
	import AccessStep from './AccessStep.svelte';
	import HealthStep from './HealthStep.svelte';
	import CompleteStep from './CompleteStep.svelte';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	const STEPS = [
		'welcome',
		'profile',
		'serviceInstances',
		'security',
		'channels',
		'accessScope',
		'healthCheck',
		'complete'
	];
	const STEP_TITLES = [
		'Welcome',
		'Profile',
		'AI Providers',
		'Security',
		'Channels',
		'Access',
		'Health Check',
		'Complete'
	];

	let stepError = $state('');
	let finishInProgress = $state(false);
	const currentStep = $derived(getWizardStep());
	const currentStepName = $derived(STEPS[currentStep]);
	const isLastContentStep = $derived(currentStep === STEPS.length - 2);
	const isComplete = $derived(currentStepName === 'complete');

	function collectChannelConfigs(): Record<string, Record<string, string>> {
		const configs: Record<string, Record<string, string>> = {};
		const fields = document.querySelectorAll<HTMLInputElement>('.wiz-ch-field');
		for (const f of fields) {
			const channel = f.getAttribute('data-channel');
			const key = f.getAttribute('data-key');
			if (!channel || !key) continue;
			if (!configs[channel]) configs[channel] = {};
			configs[channel][key] = f.value;
		}
		return configs;
	}

	async function wizardNext() {
		stepError = '';

		if (currentStepName === 'profile') {
			const name =
				(document.getElementById('wiz-profile-name') as HTMLInputElement)?.value || '';
			const email =
				(document.getElementById('wiz-profile-email') as HTMLInputElement)?.value || '';
			const password =
				(document.getElementById('wiz-profile-password') as HTMLInputElement)?.value || '';
			const password2 =
				(document.getElementById('wiz-profile-password2') as HTMLInputElement)?.value || '';

			// Only validate password if one is being set (skip on re-runs where setup is already complete)
			const setupAlreadyComplete = getSetupState()?.completed ?? false;
			if (!setupAlreadyComplete || password.length > 0) {
				if (password.length < 8) {
					stepError = 'Password must be at least 8 characters.';
					return;
				}
				if (password !== password2) {
					stepError = 'Passwords do not match.';
					return;
				}
			}

			const profileResult = await api('/command', {
				method: 'POST',
				body: JSON.stringify({
					type: 'setup.profile',
					payload: { name, email, password }
				})
			});
			if (!profileResult.ok) {
				stepError = 'Could not save your profile. Please try again.';
				return;
			}
			if (password.length >= 8) setAdminToken(password);
		}

		if (currentStepName === 'serviceInstances') {
			const openmemory =
				(document.getElementById('wiz-svc-openmemory') as HTMLInputElement)?.value || '';
			const psql =
				(document.getElementById('wiz-svc-psql') as HTMLInputElement)?.value || '';
			const qdrant =
				(document.getElementById('wiz-svc-qdrant') as HTMLInputElement)?.value || '';
			const openaiBaseUrl =
				(document.getElementById('wiz-openmemory-openai-base') as HTMLInputElement)
					?.value || '';
			const openaiApiKey =
				(document.getElementById('wiz-openmemory-openai-key') as HTMLInputElement)
					?.value || '';
			const anthropicApiKey =
				(document.getElementById('wiz-anthropic-key') as HTMLInputElement)?.value || '';

			const smallModelEndpoint =
				(document.getElementById('wiz-small-model-endpoint') as HTMLInputElement)?.value ||
				'';
			const smallModelApiKey =
				(document.getElementById('wiz-small-model-key') as HTMLInputElement)?.value || '';
			const smallModelId =
				(document.getElementById('wiz-small-model-id') as HTMLInputElement)?.value || '';

			const servicePayload: Record<string, string> = {
				openmemory,
				psql,
				qdrant,
				openaiBaseUrl,
				smallModelEndpoint,
				smallModelId
			};
			if (openaiApiKey.trim()) servicePayload.openaiApiKey = openaiApiKey.trim();
			if (anthropicApiKey.trim()) servicePayload.anthropicApiKey = anthropicApiKey.trim();
			if (smallModelApiKey.trim()) servicePayload.smallModelApiKey = smallModelApiKey.trim();

			const serviceResult = await api('/command', {
				method: 'POST',
				body: JSON.stringify({
					type: 'setup.service_instances',
					payload: servicePayload
				})
			});
			if (!serviceResult.ok) {
				stepError = 'Could not save service settings. Please try again.';
				return;
			}
		}

		if (currentStepName === 'accessScope') {
			const selected = document.querySelector<HTMLInputElement>(
				'input[name="wiz-scope"]:checked'
			);
			const scope = selected ? selected.value : 'host';
			const scopeResult = await api('/command', {
				method: 'POST',
				body: JSON.stringify({ type: 'setup.access_scope', payload: { scope } })
			});
			if (!scopeResult.ok) {
				stepError = 'Could not save your access preference. Please try again.';
				return;
			}
		}

		// Mark step complete
		await api('/command', {
			method: 'POST',
			body: JSON.stringify({ type: 'setup.step', payload: { step: currentStepName } })
		});

		setWizardStep(currentStep + 1);
	}

	function wizardPrev() {
		setWizardStep(currentStep - 1);
	}

	async function finishSetup() {
		if (finishInProgress) return;
		finishInProgress = true;
		stepError = '';

		try {
			// Save channel selections
			const enabledChannels = Array.from(
				document.querySelectorAll<HTMLInputElement>('.wiz-ch:checked')
			).map((c) => c.value);
			const channelConfigs = collectChannelConfigs();

			const channelsResult = await api('/command', {
				method: 'POST',
				body: JSON.stringify({
					type: 'setup.channels',
					payload: { channels: enabledChannels, channelConfigs }
				})
			});
			if (!channelsResult.ok) {
				stepError = 'Could not save channel configuration. Please try again.';
				return;
			}

			// Mark step complete
			const stepResult = await api('/command', {
				method: 'POST',
				body: JSON.stringify({ type: 'setup.step', payload: { step: currentStepName } })
			});
			if (!stepResult.ok) {
				stepError = 'Could not save step progress. Please try again.';
				return;
			}

			// Finalize — this triggers stack apply and core service restart
			const completeResult = await api('/command', {
				method: 'POST',
				body: JSON.stringify({ type: 'setup.complete', payload: {} })
			});
			if (!completeResult.ok) {
				const errorMsg = completeResult.data?.error ?? 'unknown error';
				stepError = `Setup failed: ${errorMsg}. Check that Docker is running and you have internet access, then click "Finish Setup" to retry.`;
				return;
			}

			// Start enabled channels after setup.complete applies full compose
			for (const channel of enabledChannels) {
				const upResult = await api('/command', {
					method: 'POST',
					body: JSON.stringify({ type: 'service.up', payload: { service: channel } })
				});
				if (!upResult.ok) {
					console.warn(`Failed to start ${channel}: ${upResult.data?.error ?? 'unknown'}`);
				}
			}

			setWizardStep(STEPS.length - 1);
		} finally {
			finishInProgress = false;
		}
	}

	function handleContinue() {
		setWizardStep(0);
		onclose();
	}
</script>

<div class="wizard-overlay" role="dialog" aria-modal="true">
	<div class="wizard">
		<h2>{STEP_TITLES[currentStep]}</h2>

		<WizardSteps steps={STEPS} current={currentStep} />

		<div class="body">
			{#if currentStepName === 'welcome'}
				<WelcomeStep />
			{:else if currentStepName === 'profile'}
				<ProfileStep error={stepError} />
			{:else if currentStepName === 'serviceInstances'}
				<ProvidersStep error={stepError} />
			{:else if currentStepName === 'security'}
				<SecurityStep />
			{:else if currentStepName === 'channels'}
				<ChannelsStep error={stepError} />
			{:else if currentStepName === 'accessScope'}
				<AccessStep error={stepError} />
			{:else if currentStepName === 'healthCheck'}
				<HealthStep />
			{:else if currentStepName === 'complete'}
				<CompleteStep oncontinue={handleContinue} />
			{/if}
		</div>

		{#if stepError && !isComplete}
			<div class="wiz-error visible" style="margin: 0.5rem 0">{stepError}</div>
		{/if}

		{#if !isComplete}
			<div class="actions">
				{#if currentStep > 0}
					<button class="btn-secondary" onclick={wizardPrev}>Back</button>
				{/if}
				{#if isLastContentStep}
					<button onclick={finishSetup} disabled={finishInProgress}>
						{finishInProgress ? 'Finishing...' : 'Finish Setup'}
					</button>
				{:else}
					<button onclick={wizardNext}>Next</button>
				{/if}
			</div>
		{/if}
	</div>
</div>
