<script lang="ts">
	import { apiGet, apiPost } from '$lib/api';
	import { showToast } from '$lib/stores/toast';
	import { setToken } from '$lib/stores/auth';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import HealthBadge from '$lib/components/HealthBadge.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import type { SetupState, HealthResult } from '$lib/types';

	// ── Step definitions ──────────────────────────────────────────────
	const STEPS = [
		'welcome',
		'accessScope',
		'serviceInstances',
		'healthCheck',
		'security',
		'channels',
		'extensions'
	] as const;

	type Step = (typeof STEPS)[number];

	const STEP_TITLES: Record<Step, string> = {
		welcome: 'Welcome',
		accessScope: 'Access Scope',
		serviceInstances: 'Services',
		healthCheck: 'Health Check',
		security: 'Security',
		channels: 'Channels',
		extensions: 'Extensions'
	};

	// ── Reactive state ────────────────────────────────────────────────
	let currentIndex = $state(0);
	let loading = $state(false);
	let initialLoading = $state(true);

	// Access scope
	let accessScope = $state<'host' | 'lan'>('host');

	// Service instances
	let openaiBaseUrl = $state('');
	let openaiApiKey = $state('');
	let anthropicApiKey = $state('');
	let openmemoryUrl = $state('');
	let psqlUrl = $state('');
	let qdrantUrl = $state('');
	let smallModelEndpoint = $state('');
	let smallModelApiKey = $state('');
	let smallModelId = $state('');
	let advancedOpen = $state(false);

	// Health check
	let healthServices = $state<Record<string, HealthResult>>({});
	let healthPolling = $state(false);
	let healthElapsed = $state(0);
	let healthTimedOut = $state(false);
	let healthPollTimer: ReturnType<typeof setInterval> | undefined;
	let healthElapsedTimer: ReturnType<typeof setInterval> | undefined;

	// Security
	let adminPassword = $state('');
	let adminPasswordConfirm = $state('');
	let securityValidated = $state(false);
	let securityValidating = $state(false);
	let securityError = $state('');

	// Channels
	const CHANNEL_OPTIONS = [
		{ id: 'channel-chat', label: 'Chat (Web UI)', description: 'Browser-based chat interface' },
		{ id: 'channel-discord', label: 'Discord', description: 'Discord bot integration' },
		{ id: 'channel-voice', label: 'Voice', description: 'Voice interaction channel' },
		{ id: 'channel-telegram', label: 'Telegram', description: 'Telegram bot integration' }
	];
	let enabledChannels = $state<string[]>([]);

	// Extensions
	const STARTER_EXTENSIONS = [
		{ id: 'ext-web-search', label: 'Web Search', description: 'Search the web from conversations' },
		{
			id: 'ext-memory-manager',
			label: 'Memory Manager',
			description: 'Manage and query stored memories'
		},
		{ id: 'ext-file-reader', label: 'File Reader', description: 'Read and summarize local files' },
		{ id: 'ext-code-runner', label: 'Code Runner', description: 'Execute code snippets safely' }
	];
	let selectedExtensions = $state<string[]>([]);
	let installingExtensions = $state(false);

	// ── Derived ───────────────────────────────────────────────────────
	let currentStep = $derived(STEPS[currentIndex]);
	let isFirstStep = $derived(currentIndex === 0);
	let isLastStep = $derived(currentIndex === STEPS.length - 1);

	let passwordsMatch = $derived(
		adminPassword.length > 0 && adminPassword === adminPasswordConfirm
	);

	let allHealthy = $derived(
		Object.keys(healthServices).length > 0 &&
			Object.values(healthServices).every((s) => s.ok)
	);

	let canProceed = $derived.by(() => {
		switch (currentStep) {
			case 'welcome':
				return true;
			case 'accessScope':
				return true;
			case 'serviceInstances':
				return true;
			case 'healthCheck':
				return allHealthy;
			case 'security':
				return securityValidated;
			case 'channels':
				return true;
			case 'extensions':
				return true;
			default:
				return false;
		}
	});

	// ── Load initial setup status ─────────────────────────────────────
	$effect(() => {
		loadSetupStatus();
	});

	async function loadSetupStatus() {
		const res = await apiGet<SetupState>('/admin/setup/status', { noAuth: true });
		if (res.ok && res.data) {
			const data = res.data;
			if (data.completed) {
				goto(`${base}/extensions`);
				return;
			}
			if (data.accessScope) accessScope = data.accessScope;
			if (data.serviceInstances) {
				openmemoryUrl = data.serviceInstances.openmemory ?? '';
				psqlUrl = data.serviceInstances.psql ?? '';
				qdrantUrl = data.serviceInstances.qdrant ?? '';
			}
			if (data.enabledChannels) enabledChannels = [...data.enabledChannels];
			if (data.installedExtensions) selectedExtensions = [...data.installedExtensions];

			// Resume from the first incomplete step
			if (data.steps) {
				for (let i = 0; i < STEPS.length; i++) {
					const stepKey = STEPS[i];
					if (!data.steps[stepKey]) {
						currentIndex = i;
						break;
					}
				}
			}
		}
		initialLoading = false;
	}

	// ── Health check polling ──────────────────────────────────────────
	function startHealthPoll() {
		stopHealthPoll();
		healthPolling = true;
		healthElapsed = 0;
		healthTimedOut = false;
		pollHealth();

		healthPollTimer = setInterval(() => {
			if (!healthPolling) return;
			pollHealth();
		}, 2000);

		healthElapsedTimer = setInterval(() => {
			healthElapsed += 1;
			if (healthElapsed >= 120) {
				healthTimedOut = true;
				stopHealthPoll();
			}
		}, 1000);
	}

	function stopHealthPoll() {
		healthPolling = false;
		if (healthPollTimer) {
			clearInterval(healthPollTimer);
			healthPollTimer = undefined;
		}
		if (healthElapsedTimer) {
			clearInterval(healthElapsedTimer);
			healthElapsedTimer = undefined;
		}
	}

	async function pollHealth() {
		const res = await apiGet<{
			services: Record<string, HealthResult>;
			serviceInstances?: Record<string, string>;
		}>('/admin/setup/health-check', { noAuth: true });
		if (res.ok && res.data?.services) {
			healthServices = res.data.services;
			if (Object.values(res.data.services).every((s) => s.ok)) {
				stopHealthPoll();
			}
		}
	}

	// Auto-start health polling when entering healthCheck step
	$effect(() => {
		if (currentStep === 'healthCheck') {
			startHealthPoll();
		}
		return () => {
			stopHealthPoll();
		};
	});

	// ── Security validation ───────────────────────────────────────────
	async function validateAdminToken() {
		if (!passwordsMatch) {
			securityError = 'Passwords do not match.';
			return;
		}
		if (adminPassword.length < 4) {
			securityError = 'Password must be at least 4 characters.';
			return;
		}
		securityValidating = true;
		securityError = '';

		setToken(adminPassword);

		const res = await apiGet<{ installed?: boolean }>('/admin/installed');
		if (res.ok) {
			securityValidated = true;
			showToast('Admin token verified.', 'success');
		} else {
			securityError = 'Could not verify token. Please check your password and try again.';
			securityValidated = false;
		}
		securityValidating = false;
	}

	// ── Navigation ────────────────────────────────────────────────────
	async function handleNext() {
		if (loading) return;
		loading = true;

		try {
			let ok = true;

			switch (currentStep) {
				case 'welcome':
					ok = (await apiPost('/admin/setup/step', { step: 'welcome' }, { noAuth: true })).ok;
					break;

				case 'accessScope':
					ok = (
						await apiPost(
							'/admin/setup/access-scope',
							{ scope: accessScope },
							{ noAuth: true }
						)
					).ok;
					break;

				case 'serviceInstances': {
					const body: Record<string, string> = {};
					if (openaiBaseUrl) body.openaiBaseUrl = openaiBaseUrl;
					if (openaiApiKey) body.openaiApiKey = openaiApiKey;
					if (anthropicApiKey) body.anthropicApiKey = anthropicApiKey;
					if (openmemoryUrl) body.openmemory = openmemoryUrl;
					if (psqlUrl) body.psql = psqlUrl;
					if (qdrantUrl) body.qdrant = qdrantUrl;
					if (smallModelEndpoint) body.smallModelEndpoint = smallModelEndpoint;
					if (smallModelApiKey) body.smallModelApiKey = smallModelApiKey;
					if (smallModelId) body.smallModelId = smallModelId;
					ok = (
						await apiPost('/admin/setup/service-instances', body, { noAuth: true })
					).ok;
					break;
				}

				case 'healthCheck':
					ok = (
						await apiPost(
							'/admin/setup/step',
							{ step: 'healthCheck' },
							{ noAuth: true }
						)
					).ok;
					break;

				case 'security':
					ok = (await apiPost('/admin/setup/step', { step: 'security' })).ok;
					break;

				case 'channels': {
					ok = (
						await apiPost('/admin/setup/channels', { channels: enabledChannels })
					).ok;
					if (ok) {
						for (const ch of enabledChannels) {
							await apiPost('/admin/containers/up', { service: ch });
						}
					}
					break;
				}

				case 'extensions': {
					if (selectedExtensions.length > 0) {
						installingExtensions = true;
						for (const extId of selectedExtensions) {
							await apiPost('/admin/gallery/install', { galleryId: extId });
						}
						installingExtensions = false;
					}
					const completeRes = await apiPost('/admin/setup/complete');
					if (completeRes.ok) {
						showToast('Setup complete!', 'success');
						goto(`${base}/extensions`);
						return;
					} else {
						ok = false;
					}
					break;
				}
			}

			if (!ok) {
				showToast('Failed to save step. Please try again.', 'error');
			} else if (!isLastStep) {
				currentIndex += 1;
			}
		} catch {
			showToast('An unexpected error occurred.', 'error');
		} finally {
			loading = false;
		}
	}

	function handleBack() {
		if (currentIndex > 0) {
			currentIndex -= 1;
		}
	}

	function toggleChannel(id: string) {
		if (enabledChannels.includes(id)) {
			enabledChannels = enabledChannels.filter((c) => c !== id);
		} else {
			enabledChannels = [...enabledChannels, id];
		}
	}

	function toggleExtension(id: string) {
		if (selectedExtensions.includes(id)) {
			selectedExtensions = selectedExtensions.filter((e) => e !== id);
		} else {
			selectedExtensions = [...selectedExtensions, id];
		}
	}

	function handleDotClick(index: number) {
		if (index < currentIndex) {
			currentIndex = index;
		}
	}

	function handleDotKeydown(e: KeyboardEvent, index: number) {
		if ((e.key === 'Enter' || e.key === ' ') && index < currentIndex) {
			e.preventDefault();
			currentIndex = index;
		}
	}
</script>

{#if initialLoading}
	<div class="wizard-overlay" role="status" aria-label="Loading setup wizard">
		<LoadingSpinner message="Loading setup..." />
	</div>
{:else}
	<div class="wizard-overlay" role="region" aria-label="Setup wizard">
		<!-- Progress dots -->
		<nav class="progress-dots" aria-label="Setup progress">
			{#each STEPS as step, i}
				<button
					class="dot"
					class:active={i === currentIndex}
					class:completed={i < currentIndex}
					class:future={i > currentIndex}
					disabled={i >= currentIndex}
					onclick={() => handleDotClick(i)}
					onkeydown={(e) => handleDotKeydown(e, i)}
					aria-label="{STEP_TITLES[step]}, step {i + 1} of {STEPS.length}{i < currentIndex
						? ' (completed)'
						: i === currentIndex
							? ' (current)'
							: ''}"
					aria-current={i === currentIndex ? 'step' : undefined}
				>
					<span class="dot-inner" aria-hidden="true">
						{#if i < currentIndex}
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="3"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<polyline points="20 6 9 17 4 12"></polyline>
							</svg>
						{/if}
					</span>
					<span class="dot-label">{STEP_TITLES[step]}</span>
				</button>
			{/each}
		</nav>

		<!-- Step content -->
		<div class="step-container">
			<div class="step-card">
				<!-- Step 1: Welcome -->
				{#if currentStep === 'welcome'}
					<div class="step-content welcome-step">
						<div class="logo-wrap">
							<img
								src="{base}/logo.png"
								alt="OpenPalm logo"
								width="80"
								height="80"
								class="setup-logo"
							/>
						</div>
						<h1>Welcome to OpenPalm</h1>
						<p class="muted description">
							OpenPalm is your self-hosted AI assistant platform. This setup wizard will walk
							you through configuring access, connecting services, verifying health, setting a
							password, and enabling channels and extensions.
						</p>
						<p class="muted">
							It should only take a few minutes. You can always change these settings later
							from the admin panel.
						</p>
					</div>

				<!-- Step 2: Access Scope -->
				{:else if currentStep === 'accessScope'}
					<div class="step-content">
						<h2>Access Scope</h2>
						<p class="muted mb">
							Choose who can access your OpenPalm instance. You can change this later in
							System settings.
						</p>

						<fieldset class="radio-group" role="radiogroup" aria-label="Access scope">
							<label class="radio-card" class:selected={accessScope === 'host'}>
								<input
									type="radio"
									name="accessScope"
									value="host"
									bind:group={accessScope}
									aria-describedby="host-desc"
								/>
								<div class="radio-card-body">
									<strong>Localhost Only</strong>
									<p id="host-desc" class="muted">
										Only accessible from this machine. Most secure for personal use.
									</p>
								</div>
							</label>

							<label class="radio-card" class:selected={accessScope === 'lan'}>
								<input
									type="radio"
									name="accessScope"
									value="lan"
									bind:group={accessScope}
									aria-describedby="lan-desc"
								/>
								<div class="radio-card-body">
									<strong>Local Network (LAN)</strong>
									<p id="lan-desc" class="muted">
										Accessible from other devices on your local network. Useful for phones,
										tablets, or other machines.
									</p>
								</div>
							</label>
						</fieldset>
					</div>

				<!-- Step 3: Service Instances -->
				{:else if currentStep === 'serviceInstances'}
					<div class="step-content">
						<h2>Service Configuration</h2>
						<p class="muted mb">
							Configure your AI provider endpoints and API keys. Fields left blank will use
							default values.
						</p>

						<div class="form-section">
							<h3>OpenAI-Compatible Endpoint</h3>
							<p class="help-text mb">
								Used by OpenMemory for embeddings and completions.
							</p>

							<div class="form-group">
								<label for="openai-base-url">Base URL</label>
								<input
									id="openai-base-url"
									type="url"
									placeholder="https://api.openai.com/v1"
									bind:value={openaiBaseUrl}
								/>
							</div>

							<div class="form-group">
								<label for="openai-api-key">API Key</label>
								<input
									id="openai-api-key"
									type="password"
									placeholder="sk-..."
									bind:value={openaiApiKey}
									autocomplete="off"
								/>
							</div>
						</div>

						<div class="form-section">
							<h3>Anthropic</h3>
							<div class="form-group">
								<label for="anthropic-api-key">API Key</label>
								<input
									id="anthropic-api-key"
									type="password"
									placeholder="sk-ant-..."
									bind:value={anthropicApiKey}
									autocomplete="off"
								/>
							</div>
						</div>

						<!-- Advanced section -->
						<div class="advanced-section">
							<button
								class="advanced-toggle"
								onclick={() => (advancedOpen = !advancedOpen)}
								aria-expanded={advancedOpen}
								aria-controls="advanced-panel"
							>
								<svg
									class="chevron"
									class:open={advancedOpen}
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<polyline points="9 18 15 12 9 6"></polyline>
								</svg>
								Advanced Configuration
							</button>

							{#if advancedOpen}
								<div id="advanced-panel" class="advanced-panel">
									<h4>Service URLs</h4>
									<p class="help-text mb">
										Override the default internal service addresses.
									</p>

									<div class="form-group">
										<label for="openmemory-url">OpenMemory URL</label>
										<input
											id="openmemory-url"
											type="url"
											placeholder="http://openmemory:8080"
											bind:value={openmemoryUrl}
										/>
									</div>

									<div class="form-group">
										<label for="psql-url">PostgreSQL URL</label>
										<input
											id="psql-url"
											type="text"
											placeholder="postgresql://user:pass@psql:5432/db"
											bind:value={psqlUrl}
										/>
									</div>

									<div class="form-group">
										<label for="qdrant-url">Qdrant URL</label>
										<input
											id="qdrant-url"
											type="url"
											placeholder="http://qdrant:6333"
											bind:value={qdrantUrl}
										/>
									</div>

									<h4 class="mt">Small Model</h4>
									<p class="help-text mb">
										Configure a lightweight model for summarization, classification, and
										other background tasks.
									</p>

									<div class="form-group">
										<label for="small-model-endpoint">Endpoint</label>
										<input
											id="small-model-endpoint"
											type="url"
											placeholder="https://api.openai.com/v1"
											bind:value={smallModelEndpoint}
										/>
									</div>

									<div class="form-group">
										<label for="small-model-api-key">API Key</label>
										<input
											id="small-model-api-key"
											type="password"
											placeholder="sk-..."
											bind:value={smallModelApiKey}
											autocomplete="off"
										/>
									</div>

									<div class="form-group">
										<label for="small-model-id">Model ID</label>
										<input
											id="small-model-id"
											type="text"
											placeholder="gpt-4o-mini"
											bind:value={smallModelId}
										/>
									</div>
								</div>
							{/if}
						</div>
					</div>

				<!-- Step 4: Health Check -->
				{:else if currentStep === 'healthCheck'}
					<div class="step-content">
						<h2>Health Check</h2>
						<p class="muted mb">
							Verifying that all core services are running. This may take a moment while
							services start up.
						</p>

						{#if healthTimedOut}
							<div class="alert alert-error" role="alert">
								Health check timed out after 120 seconds. Some services may need manual
								attention.
								<button class="btn-sm mt" onclick={() => startHealthPoll()}>
									Retry
								</button>
							</div>
						{/if}

						<div class="health-list" role="list" aria-label="Service health status">
							{#each ['gateway', 'controller', 'opencodeCore', 'openmemory', 'admin'] as svc}
								{@const result = healthServices[svc]}
								<div class="health-row" role="listitem">
									<div class="health-info">
										<HealthBadge ok={result?.ok ?? null} />
										<span class="health-name">{svc}</span>
									</div>
									<div class="health-detail">
										{#if result?.ok}
											<span class="health-ok">OK</span>
											{#if result.time}
												<span class="muted health-time">{result.time}</span>
											{/if}
										{:else if result?.error}
											<span class="health-err">{result.error}</span>
										{:else}
											<span class="muted">Waiting...</span>
										{/if}
									</div>
								</div>
							{/each}
						</div>

						{#if healthPolling && !allHealthy}
							<div class="health-status">
								<LoadingSpinner size={18} />
								<span class="muted">Checking services... ({healthElapsed}s)</span>
							</div>
						{/if}

						{#if allHealthy}
							<div class="alert alert-success" role="status">
								All services are healthy. You can proceed to the next step.
							</div>
						{/if}
					</div>

				<!-- Step 5: Security -->
				{:else if currentStep === 'security'}
					<div class="step-content">
						<h2>Admin Password</h2>
						<p class="muted mb">
							Set an admin password (x-admin-token) to protect the admin panel. You will
							need this to access the admin interface.
						</p>

						<div class="form-group">
							<label for="admin-password">Password</label>
							<input
								id="admin-password"
								type="password"
								placeholder="Enter admin password"
								bind:value={adminPassword}
								autocomplete="new-password"
								oninput={() => {
									securityValidated = false;
									securityError = '';
								}}
							/>
						</div>

						<div class="form-group">
							<label for="admin-password-confirm">Confirm Password</label>
							<input
								id="admin-password-confirm"
								type="password"
								placeholder="Confirm admin password"
								bind:value={adminPasswordConfirm}
								autocomplete="new-password"
								oninput={() => {
									securityValidated = false;
									securityError = '';
								}}
								onkeydown={(e) => {
									if (e.key === 'Enter' && passwordsMatch) validateAdminToken();
								}}
							/>
						</div>

						{#if adminPasswordConfirm.length > 0 && !passwordsMatch}
							<p class="field-error" role="alert">Passwords do not match.</p>
						{/if}

						{#if securityError}
							<div class="alert alert-error" role="alert">{securityError}</div>
						{/if}

						{#if securityValidated}
							<div class="alert alert-success" role="status">
								Admin token verified successfully.
							</div>
						{/if}

						<div class="mt">
							<button
								class="btn-validate"
								onclick={validateAdminToken}
								disabled={!passwordsMatch ||
									securityValidating ||
									securityValidated}
							>
								{#if securityValidating}
									<LoadingSpinner size={16} />
									Verifying...
								{:else if securityValidated}
									Verified
								{:else}
									Verify Token
								{/if}
							</button>
						</div>
					</div>

				<!-- Step 6: Channels -->
				{:else if currentStep === 'channels'}
					<div class="step-content">
						<h2>Enable Channels</h2>
						<p class="muted mb">
							Choose which communication channels to enable. You can always add or remove
							channels later.
						</p>

						<fieldset class="checkbox-group" aria-label="Available channels">
							{#each CHANNEL_OPTIONS as channel}
								<label
									class="checkbox-card"
									class:selected={enabledChannels.includes(channel.id)}
								>
									<input
										type="checkbox"
										checked={enabledChannels.includes(channel.id)}
										onchange={() => toggleChannel(channel.id)}
										aria-describedby="ch-{channel.id}-desc"
									/>
									<div class="checkbox-card-body">
										<strong>{channel.label}</strong>
										<p id="ch-{channel.id}-desc" class="muted">
											{channel.description}
										</p>
									</div>
								</label>
							{/each}
						</fieldset>

						{#if enabledChannels.length === 0}
							<p class="muted help-text mt">
								No channels selected. You can enable channels later from the Channels page.
							</p>
						{/if}
					</div>

				<!-- Step 7: Extensions -->
				{:else if currentStep === 'extensions'}
					<div class="step-content">
						<h2>Starter Extensions</h2>
						<p class="muted mb">
							Install some popular extensions to get started. You can browse and install more
							from the Extensions gallery.
						</p>

						<fieldset
							class="checkbox-group"
							aria-label="Available starter extensions"
						>
							{#each STARTER_EXTENSIONS as ext}
								<label
									class="checkbox-card"
									class:selected={selectedExtensions.includes(ext.id)}
								>
									<input
										type="checkbox"
										checked={selectedExtensions.includes(ext.id)}
										onchange={() => toggleExtension(ext.id)}
										aria-describedby="ext-{ext.id}-desc"
									/>
									<div class="checkbox-card-body">
										<strong>{ext.label}</strong>
										<p id="ext-{ext.id}-desc" class="muted">
											{ext.description}
										</p>
									</div>
								</label>
							{/each}
						</fieldset>

						{#if installingExtensions}
							<div class="mt">
								<LoadingSpinner message="Installing extensions..." />
							</div>
						{/if}

						{#if selectedExtensions.length === 0}
							<p class="muted help-text mt">
								No extensions selected. You can install extensions later from the Extensions
								page.
							</p>
						{/if}
					</div>
				{/if}

				<!-- Navigation buttons -->
				<div class="step-nav">
					{#if !isFirstStep}
						<button
							class="btn-secondary"
							onclick={handleBack}
							disabled={loading}
							aria-label="Go to previous step"
						>
							Back
						</button>
					{:else}
						<div></div>
					{/if}

					<button
						onclick={handleNext}
						disabled={!canProceed || loading || installingExtensions}
						aria-label={isLastStep ? 'Complete setup' : 'Go to next step'}
					>
						{#if loading}
							<LoadingSpinner size={16} />
							{isLastStep ? 'Completing...' : 'Saving...'}
						{:else if isLastStep}
							Complete Setup
						{:else}
							Next
						{/if}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	/* ── Overlay & layout ─────────────────────────────────────── */
	.wizard-overlay {
		position: fixed;
		inset: 0;
		background: var(--bg);
		z-index: 100;
		display: flex;
		flex-direction: column;
		align-items: center;
		overflow-y: auto;
	}

	/* ── Progress dots ────────────────────────────────────────── */
	.progress-dots {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		padding: 1.5rem 1rem 0.5rem;
		flex-shrink: 0;
	}

	.dot {
		background: transparent;
		border: none;
		padding: 0.4rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		cursor: default;
		color: var(--muted);
		min-width: 72px;
	}

	.dot:not(:disabled) {
		cursor: pointer;
	}

	.dot:not(:disabled):hover .dot-inner {
		border-color: var(--accent2);
	}

	.dot-inner {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 2px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: center;
		transition:
			border-color 0.2s,
			background 0.2s;
		color: white;
		font-size: 12px;
	}

	.dot.active .dot-inner {
		border-color: var(--accent);
		background: var(--accent);
	}

	.dot.completed .dot-inner {
		border-color: var(--green);
		background: var(--green);
	}

	.dot.future .dot-inner {
		border-color: var(--border);
		background: transparent;
	}

	.dot-label {
		font-size: 11px;
		white-space: nowrap;
		color: var(--muted);
	}

	.dot.active .dot-label {
		color: var(--text);
		font-weight: 600;
	}

	.dot.completed .dot-label {
		color: var(--green);
	}

	/* ── Step container ───────────────────────────────────────── */
	.step-container {
		width: 100%;
		max-width: 600px;
		padding: 1rem;
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.step-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 2rem;
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.step-content {
		flex: 1;
	}

	.step-content h2 {
		margin: 0 0 0.25rem;
		font-size: 22px;
	}

	.step-content h3 {
		margin: 1rem 0 0.25rem;
		font-size: 16px;
		color: var(--text);
	}

	.step-content h4 {
		margin: 0.75rem 0 0.25rem;
		font-size: 14px;
		color: var(--text);
	}

	.description {
		font-size: 15px;
		line-height: 1.6;
		max-width: 480px;
		margin: 0 auto 0.75rem;
	}

	/* ── Welcome step ─────────────────────────────────────────── */
	.welcome-step {
		text-align: center;
		padding-top: 1rem;
	}

	.welcome-step h1 {
		margin: 0 0 0.75rem;
		font-size: 28px;
	}

	.logo-wrap {
		margin-bottom: 1.25rem;
	}

	.setup-logo {
		border-radius: 16px;
		box-shadow: 0 4px 24px rgba(99, 102, 241, 0.15);
	}

	/* ── Radio cards ──────────────────────────────────────────── */
	.radio-group {
		border: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.radio-card {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--surface2);
		border: 2px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	.radio-card:hover {
		border-color: var(--accent);
	}

	.radio-card.selected {
		border-color: var(--accent);
		background: rgba(99, 102, 241, 0.06);
	}

	.radio-card input[type='radio'] {
		width: 18px;
		height: 18px;
		margin-top: 2px;
		flex-shrink: 0;
		accent-color: var(--accent);
	}

	.radio-card-body {
		flex: 1;
	}

	.radio-card-body strong {
		display: block;
		margin-bottom: 0.15rem;
	}

	.radio-card-body p {
		margin: 0;
		font-size: 13px;
		line-height: 1.4;
	}

	/* ── Checkbox cards ───────────────────────────────────────── */
	.checkbox-group {
		border: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.checkbox-card {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.85rem 1rem;
		background: var(--surface2);
		border: 2px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	.checkbox-card:hover {
		border-color: var(--accent);
	}

	.checkbox-card.selected {
		border-color: var(--accent);
		background: rgba(99, 102, 241, 0.06);
	}

	.checkbox-card input[type='checkbox'] {
		width: 18px;
		height: 18px;
		margin-top: 2px;
		flex-shrink: 0;
		accent-color: var(--accent);
	}

	.checkbox-card-body {
		flex: 1;
	}

	.checkbox-card-body strong {
		display: block;
		margin-bottom: 0.1rem;
		font-size: 14px;
	}

	.checkbox-card-body p {
		margin: 0;
		font-size: 13px;
		line-height: 1.3;
	}

	/* ── Form sections ────────────────────────────────────────── */
	.form-section {
		margin-bottom: 0.5rem;
	}

	/* ── Advanced toggle ──────────────────────────────────────── */
	.advanced-section {
		margin-top: 1.25rem;
		border-top: 1px solid var(--border);
		padding-top: 1rem;
	}

	.advanced-toggle {
		background: transparent;
		color: var(--muted);
		padding: 0.4rem 0;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 14px;
		font-weight: 600;
		border: none;
		border-radius: 0;
	}

	.advanced-toggle:hover {
		color: var(--text);
		opacity: 1;
	}

	.chevron {
		transition: transform 0.2s;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.advanced-panel {
		padding-top: 0.75rem;
	}

	/* ── Health check ─────────────────────────────────────────── */
	.health-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.health-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.7rem 1rem;
		background: var(--surface2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.health-info {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.health-name {
		font-weight: 500;
		font-size: 14px;
	}

	.health-detail {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 13px;
	}

	.health-ok {
		color: var(--green);
		font-weight: 600;
	}

	.health-err {
		color: var(--red);
		font-size: 12px;
	}

	.health-time {
		font-size: 12px;
	}

	.health-status {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	/* ── Alerts ───────────────────────────────────────────────── */
	.alert {
		padding: 0.75rem 1rem;
		border-radius: var(--radius);
		font-size: 14px;
		margin-top: 1rem;
		border: 1px solid var(--border);
	}

	.alert-success {
		border-color: var(--green);
		color: var(--green);
		background: rgba(34, 197, 94, 0.06);
	}

	.alert-error {
		border-color: var(--red);
		color: var(--red);
		background: rgba(239, 68, 68, 0.06);
	}

	/* ── Security ─────────────────────────────────────────────── */
	.field-error {
		color: var(--red);
		font-size: 13px;
		margin: 0.25rem 0 0;
	}

	.btn-validate {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		background: var(--surface2);
		color: var(--text);
		border: 1px solid var(--border);
		padding: 0.5rem 1.2rem;
	}

	.btn-validate:hover:not(:disabled) {
		border-color: var(--accent);
	}

	/* ── Navigation buttons ───────────────────────────────────── */
	.step-nav {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 2rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border);
	}

	.step-nav button {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 100px;
		justify-content: center;
	}

	/* ── Responsive ───────────────────────────────────────────── */
	@media (max-width: 640px) {
		.step-card {
			padding: 1.25rem;
		}

		.progress-dots {
			gap: 0.1rem;
			padding: 1rem 0.5rem 0.5rem;
			flex-wrap: wrap;
		}

		.dot {
			min-width: 44px;
		}

		.dot-label {
			font-size: 9px;
		}

		.dot-inner {
			width: 24px;
			height: 24px;
		}

		.welcome-step h1 {
			font-size: 22px;
		}
	}
</style>
