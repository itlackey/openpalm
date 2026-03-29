<script lang="ts">
	import { getAdminToken } from '$lib/auth.js';
	import { buildHeaders } from '$lib/api.js';
	import { onDestroy } from 'svelte';

	import type { ProviderActionResult, ProviderAuthPrompt, ProviderView } from '$lib/types/providers.js';

	let {
		provider,
		currentModel,
		currentSmallModel,
		allowlistActive,
		onaction
	}: {
		provider: ProviderView;
		currentModel?: string;
		currentSmallModel?: string;
		allowlistActive: boolean;
		onaction?: (result: ProviderActionResult) => void;
	} = $props();

	let actionResult = $state<ProviderActionResult | undefined>(undefined);
	let submitting = $state(false);

	const oauthState = $derived(actionResult?.oauth?.providerId === provider.id ? actionResult.oauth : undefined);
	const visibleAuthMethods = $derived(
		provider.authMethods.filter((m) => !m.label.toLowerCase().includes('headless'))
	);
	let autoOauthStatus = $state<'idle' | 'pending' | 'timed_out' | 'complete' | 'error'>('idle');
	let autoOauthError = $state('');
	let pollHandle: ReturnType<typeof setTimeout> | undefined;
	let callbackStartHandle: ReturnType<typeof setTimeout> | undefined;

	function previousPromptValue(methodIndex: number, prompt: ProviderAuthPrompt) {
		if (oauthState?.methodIndex !== methodIndex) return prompt.options?.[0] ?? '';
		return oauthState.inputs?.[prompt.key] ?? prompt.options?.[0] ?? '';
	}

	function stopPolling() {
		if (pollHandle) { clearTimeout(pollHandle); pollHandle = undefined; }
		if (callbackStartHandle) { clearTimeout(callbackStartHandle); callbackStartHandle = undefined; }
	}

	function startAutoCallback(providerId: string, methodIndex: number, authUrl: string) {
		stopPolling();
		autoOauthStatus = 'pending';
		autoOauthError = '';
		window.open(authUrl, '_blank');

		pollHandle = setTimeout(() => {
			if (autoOauthStatus === 'pending') {
				autoOauthStatus = 'timed_out';
				stopPolling();
			}
		}, 600_000);

		callbackStartHandle = setTimeout(() => {
			const token = getAdminToken() ?? '';
			void fetch(`/admin/providers/oauth/${encodeURIComponent(providerId)}/callback`, {
				method: 'POST',
				headers: { ...buildHeaders(token), 'content-type': 'application/json' },
				body: JSON.stringify({ method: methodIndex })
			})
				.then(async (response) => {
					if (!response.ok) throw new Error(`Callback failed with ${response.status}`);
					autoOauthStatus = 'complete';
					stopPolling();
					onaction?.({ ok: true, message: 'OAuth connection completed.', selectedProviderId: providerId });
				})
				.catch((err) => {
					autoOauthStatus = 'error';
					autoOauthError = err instanceof Error ? err.message : 'Authorization failed.';
					stopPolling();
				});
		}, 0);
	}

	async function submitAction(actionName: string, formData: FormData) {
		submitting = true;
		actionResult = undefined;
		try {
			const token = getAdminToken() ?? '';
			const body: Record<string, unknown> = { action: actionName };
			for (const [key, value] of formData.entries()) {
				if (typeof value === 'string') body[key] = value;
			}

			const response = await fetch('/admin/providers/actions', {
				method: 'POST',
				headers: { ...buildHeaders(token), 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});

			const result = (await response.json()) as ProviderActionResult;
			actionResult = result;
			if (result.ok === true) {
				setTimeout(() => { if (actionResult?.ok === true) actionResult = undefined; }, 4000);
			}

			if (result.oauth?.mode === 'auto') {
				startAutoCallback(result.oauth.providerId, result.oauth.methodIndex, result.oauth.url);
			} else {
				autoOauthStatus = 'idle';
				autoOauthError = '';
			}

			onaction?.(result);
		} catch (err) {
			actionResult = { ok: false, message: err instanceof Error ? err.message : 'Request failed.' };
		} finally {
			submitting = false;
		}
	}

	function handleFormSubmit(actionName: string, event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		void submitAction(actionName, new FormData(form));
	}

	onDestroy(() => { stopPolling(); });

	const currentMainModelId = $derived(
		currentModel?.startsWith(`${provider.id}/`) ? currentModel.slice(provider.id.length + 1) : provider.recommendedModelId
	);
	const currentSmallModelId = $derived(
		currentSmallModel?.startsWith(`${provider.id}/`)
			? currentSmallModel.slice(provider.id.length + 1)
			: provider.recommendedModelId
	);
</script>

<section class="editor-shell">
	<header class="editor-header">
		<div>
			<span class="editor-eyebrow">Provider editor</span>
			<h2 class="editor-title">{provider.name}</h2>
			<p class="editor-desc">
				Manage how OpenCode reaches <strong>{provider.id}</strong>, choose a model, and tune request behavior.
			</p>
		</div>

		<div class="tag-row">
			<span class="tag">{provider.modelCount} models</span>
			{#if provider.connected}
				<span class="tag tag--strong">Connected</span>
			{/if}
			{#if provider.configured}
				<span class="tag">Configured</span>
			{/if}
		</div>
	</header>

	{#if actionResult?.message}
		<div class="feedback" class:feedback--success={actionResult.ok === true} class:feedback--error={actionResult.ok === false}>
			<span>{actionResult.message}</span>
			<button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => { actionResult = undefined; }}>&#x2715;</button>
		</div>
	{/if}

	<div class="panel-grid">
		<!-- Availability -->
		<section class="panel panel--accent">
			<div class="panel-heading">
				<div>
					<h3 class="panel-title">Availability</h3>
					<p class="panel-desc">{allowlistActive ? 'This workspace uses an allowlist, so toggles update both lists.' : 'Disabled providers are hidden from OpenCode model selection.'}</p>
				</div>

				<form autocomplete="off" onsubmit={(e) => handleFormSubmit('toggleProvider', e)}>
					<input type="hidden" name="providerId" value={provider.id} />
					<input type="hidden" name="enabled" value={provider.disabled ? 'true' : 'false'} />
					<button
						class="btn btn-sm"
						class:btn-outline={provider.disabled}
						class:btn-ghost={!provider.disabled}
						style={!provider.disabled ? 'color: var(--color-danger);' : ''}
						type="submit"
						disabled={submitting}
					>
						{provider.disabled ? 'Enable provider' : 'Disable provider'}
					</button>
				</form>
			</div>

			{#if provider.env.length > 0}
				<div class="detail-block">
					<span class="detail-label">Detected env vars</span>
					<span class="detail-value">{provider.env.join(', ')}</span>
				</div>
			{/if}

			<div class="detail-block">
				<span class="detail-label">Source</span>
				<span class="detail-value">{provider.source}</span>
			</div>
		</section>

		<!-- Model selection -->
		<section class="panel">
			<div class="panel-heading panel-heading--compact">
				<div>
					<h3 class="panel-title">Recommended model</h3>
					<p class="panel-desc">Pick the main or small model OpenCode should reach for first.</p>
				</div>
			</div>

			<form class="model-form" autocomplete="off" onsubmit={(e) => handleFormSubmit('setModel', e)}>
				<input type="hidden" name="providerId" value={provider.id} />
				<input type="hidden" name="target" value="model" />
				<div class="form-field form-field--grow">
					<label class="form-label" for="main-model-{provider.id}">Main model</label>
					<select id="main-model-{provider.id}" name="modelId" class="form-input">
						{#each provider.models as model (model.id)}
							<option selected={model.id === currentMainModelId} value={model.id}>{model.name}</option>
						{/each}
					</select>
				</div>
				<button class="btn btn-primary btn-sm" type="submit" disabled={submitting}>Use as main model</button>
			</form>

			<form class="model-form" autocomplete="off" onsubmit={(e) => handleFormSubmit('setModel', e)}>
				<input type="hidden" name="providerId" value={provider.id} />
				<input type="hidden" name="target" value="small_model" />
				<div class="form-field form-field--grow">
					<label class="form-label" for="small-model-{provider.id}">Small model</label>
					<select id="small-model-{provider.id}" name="modelId" class="form-input">
						{#each provider.models as model (model.id)}
							<option selected={model.id === currentSmallModelId} value={model.id}>{model.name}</option>
						{/each}
					</select>
				</div>
				<button class="btn btn-outline btn-sm" type="submit" disabled={submitting}>Set as small model</button>
			</form>
		</section>
	</div>

	<!-- Connection settings -->
	<section class="panel">
		<div class="panel-heading">
			<div>
				<h3 class="panel-title">Connection settings</h3>
				<p class="panel-desc">These values are written into your local OpenCode config so they stay with this project.</p>
			</div>
		</div>

		<form class="settings-grid" autocomplete="off" onsubmit={(e) => handleFormSubmit('saveProvider', e)}>
			<input type="hidden" name="providerId" value={provider.id} />

			<div class="form-field">
				<label class="form-label" for="apiKey-{provider.id}">API key</label>
				<input id="apiKey-{provider.id}" name="apiKey" type="password" autocomplete="new-password" class="form-input" value={provider.options.apiKey ?? ''} placeholder="Paste an API key if you want project-local auth" />
			</div>

			<div class="form-field">
				<label class="form-label" for="baseURL-{provider.id}">Base URL</label>
				<input id="baseURL-{provider.id}" name="baseURL" type="url" class="form-input" value={provider.options.baseURL ?? ''} placeholder="https://api.example.com/v1" />
			</div>

			<div class="form-field">
				<label class="form-label" for="timeout-{provider.id}">Timeout (ms)</label>
				<input id="timeout-{provider.id}" name="timeout" inputmode="numeric" class="form-input" value={provider.options.timeout ?? ''} placeholder="300000" />
			</div>

			<div class="form-field">
				<label class="form-label" for="chunkTimeout-{provider.id}">Chunk timeout (ms)</label>
				<input id="chunkTimeout-{provider.id}" name="chunkTimeout" inputmode="numeric" class="form-input" value={provider.options.chunkTimeout ?? ''} placeholder="30000" />
			</div>

			<label class="checkbox-row">
				<input checked={provider.options.setCacheKey === true} name="setCacheKey" type="checkbox" />
				<span>Always set cache keys for this provider</span>
			</label>

			<div class="action-row">
				<button class="btn btn-primary btn-sm" type="submit" disabled={submitting}>Save provider settings</button>
			</div>
		</form>
	</section>

	<!-- Auth methods -->
	<section class="panel">
		<div class="panel-heading">
			<div>
				<h3 class="panel-title">Connect with OpenCode auth</h3>
				<p class="panel-desc">When OpenCode exposes browser sign-in, you can launch it here and finish the callback locally.</p>
			</div>
		</div>

		{#if provider.authMethods.length === 0}
			<p class="empty-hint">No direct auth methods are exposed by the local API for this provider. Use config values or environment variables instead.</p>
		{:else}
			<div class="method-list">
				{#each visibleAuthMethods as method (method.index)}
					<div class="method-card">
						<div>
							<span class="detail-label">{method.type === 'oauth' ? 'OAuth' : 'API credential'}</span>
							<h4 class="method-title">{method.label}</h4>
							{#if method.prompts.length > 0}
								<p class="panel-desc">Additional fields may be requested by the local auth flow.</p>
							{/if}
						</div>

						{#if method.type === 'oauth'}
							<form autocomplete="off" onsubmit={(e) => handleFormSubmit('startOauth', e)}>
								<input type="hidden" name="providerId" value={provider.id} />
								<input type="hidden" name="methodIndex" value={method.index} />

								{#each method.prompts as prompt (prompt.key)}
									<div class="form-field prompt-field">
										<label class="form-label" for="prompt-{provider.id}-{method.index}-{prompt.key}">{prompt.message}</label>
										{#if prompt.options && prompt.options.length > 0}
											<select id="prompt-{provider.id}-{method.index}-{prompt.key}" name={`inputs[${prompt.key}]`} class="form-input" value={previousPromptValue(method.index, prompt)}>
												{#each prompt.options as option (option)}
													<option value={option}>{option}</option>
												{/each}
											</select>
										{:else}
											<input
												id="prompt-{provider.id}-{method.index}-{prompt.key}"
												name={`inputs[${prompt.key}]`}
												class="form-input"
												placeholder={prompt.placeholder ?? prompt.message}
												value={previousPromptValue(method.index, prompt)}
											/>
										{/if}
									</div>
								{/each}

								<button class="btn btn-outline btn-sm" type="submit" disabled={submitting}>Launch OAuth</button>
							</form>
						{:else}
							<span class="hint-pill">Use the settings form above</span>
						{/if}
					</div>
				{/each}
			</div>

			{#if oauthState}
				<div class="oauth-box">
					<span class="detail-label">Next step</span>
					{#if oauthState.mode === 'auto'}
						<p class="panel-desc">
							Visit <a href={oauthState.url} rel="noreferrer" target="_blank" class="text-link">the provider authorization page</a>.
							Then return here while OpenCode waits for authorization.
						</p>

						{#if autoOauthStatus === 'pending'}
							<p class="panel-desc"><span class="spinner"></span> Waiting for OpenCode to complete sign-in.</p>
						{:else if autoOauthStatus === 'timed_out'}
							<p class="panel-desc">Still waiting for the local callback to finish.</p>
						{:else if autoOauthStatus === 'complete'}
							<p class="panel-desc">Connection detected. This provider should now show as connected.</p>
						{:else if autoOauthStatus === 'error'}
							<p class="panel-desc" style="color: var(--color-danger)">Authorization failed: {autoOauthError}</p>
						{/if}
					{:else}
						<p class="panel-desc">
							Open <a href={oauthState.url} rel="noreferrer" target="_blank" class="text-link">the provider authorization page</a> to continue.
						</p>
					{/if}

					{#if oauthState.instructions}
						<p class="panel-desc">{oauthState.instructions}</p>
					{/if}

					{#if oauthState.mode === 'code'}
						<form class="oauth-code-form" autocomplete="off" onsubmit={(e) => handleFormSubmit('finishOauth', e)}>
							<input type="hidden" name="providerId" value={provider.id} />
							<input type="hidden" name="methodIndex" value={oauthState.methodIndex} />
							<div class="form-field">
								<label class="form-label" for="oauth-code-{provider.id}">Authorization code</label>
								<input id="oauth-code-{provider.id}" name="code" class="form-input" placeholder="Paste the code you received" />
							</div>
							<button class="btn btn-primary btn-sm" type="submit" disabled={submitting}>Finish OAuth</button>
						</form>
					{/if}
				</div>
			{/if}
		{/if}
	</section>
</section>

<style>
	.editor-shell {
		display: grid;
		gap: var(--space-3);
	}

	.editor-header {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		align-items: flex-start;
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
	}

	.editor-eyebrow,
	.detail-label {
		font-size: var(--text-xs);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-text-tertiary);
		font-weight: var(--font-semibold);
	}

	.editor-title {
		margin: var(--space-1) 0 0;
		font-size: var(--text-xl);
		font-weight: var(--font-semibold);
		color: var(--color-text);
	}

	.editor-desc,
	.panel-desc,
	.detail-value,
	.empty-hint {
		margin: var(--space-1) 0 0;
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		line-height: 1.55;
	}

	.tag-row,
	.panel-grid,
	.method-list,
	.action-row {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.panel-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.tag,
	.hint-pill {
		display: inline-flex;
		align-items: center;
		padding: 2px var(--space-2);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		font-size: var(--text-xs);
	}

	.tag--strong {
		background: var(--color-success-bg);
		border-color: var(--color-success);
		color: var(--color-success);
	}

	.panel {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
	}

	.panel--accent {
		background: var(--color-bg-secondary);
	}

	.panel-heading {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		align-items: center;
	}

	.panel-heading--compact {
		align-items: flex-start;
	}

	.panel-title {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: var(--font-semibold);
		color: var(--color-text);
	}

	.detail-block {
		display: grid;
		gap: 2px;
	}

	.settings-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
		align-items: start;
	}

	.form-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.form-field--grow {
		flex: 1;
	}

	.checkbox-row {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
	}

	.checkbox-row input[type="checkbox"] {
		width: 16px;
		height: 16px;
		padding: 0;
	}

	.action-row {
		grid-column: 1 / -1;
		justify-content: flex-end;
	}

	.model-form {
		display: flex;
		align-items: flex-end;
		gap: var(--space-3);
	}

	.model-form + .model-form {
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
		margin-top: var(--space-1);
	}

	.method-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: var(--space-3);
	}

	.method-card,
	.oauth-box {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		border-radius: var(--radius-md);
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
	}

	.method-title {
		margin: var(--space-1) 0 0;
		font-size: var(--text-sm);
		font-weight: var(--font-semibold);
	}

	.oauth-code-form {
		display: grid;
		gap: var(--space-2);
	}

	.prompt-field {
		margin-bottom: var(--space-2);
	}

	.feedback {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		font-size: var(--text-sm);
		border-radius: var(--radius-md);
	}

	.feedback span { flex: 1; }
	.feedback--success { background: var(--color-success-bg); color: var(--color-text); }
	.feedback--error { background: var(--color-danger-bg); color: var(--color-text); }

	.btn-dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 32px;
		min-height: 32px;
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		color: inherit;
		cursor: pointer;
		opacity: 0.6;
		font-size: var(--text-base);
		flex-shrink: 0;
	}
	.btn-dismiss:hover { opacity: 1; background: rgba(0, 0, 0, 0.06); }

	.text-link {
		color: var(--color-primary);
		text-decoration: underline;
	}

	@media (max-width: 860px) {
		.panel-grid,
		.settings-grid {
			grid-template-columns: 1fr;
		}

		.model-form {
			flex-direction: column;
			align-items: stretch;
		}

		.panel-heading,
		.editor-header {
			flex-direction: column;
			align-items: flex-start;
		}

		.action-row {
			justify-content: stretch;
		}
	}
</style>
