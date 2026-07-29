<!--
  ConnectSheet — modal/sheet for signing in to a provider.

  Mirrors OpenCode's own Connect flow:
    1. If the provider has more than one auth method, show a method picker.
    2. After a method is selected (or if there's only one), show the form:
       - API key: hint + input + Continue
       - OAuth code: hint with "this link" + auth code input + Continue
       - OAuth auto: "Authorization in progress…" (browser tab handles it,
         we poll the callback endpoint)
    3. On success, the parent reloads the provider list.

  Header has Back arrow + Close × (no Cancel button — close via header).
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import FormField from '$lib/components/common/FormField.svelte';
	import Drawer from '$lib/components/common/Drawer.svelte';
	import {
		startProviderOauth,
		oauthCallback,
		submitProviderApiKey,
		finishProviderOauth,
	} from '$lib/api/providers.js';
	import { toMessage } from '$lib/api/errors.js';
	import type {
		ProviderActionResult,
		ProviderAuthMethod,
		ProviderView
	} from '$lib/types/providers.js';

	let {
		provider,
		onaction,
		onclose,
		returnFocus
	}: {
		provider: ProviderView;
		onaction?: (result: ProviderActionResult) => void;
		onclose?: () => void;
		returnFocus?: () => HTMLElement | null;
	} = $props();

	type Step = 'method-picker' | 'api-form' | 'oauth-code' | 'oauth-auto' | 'success';

	// `methods` is derived from `provider`, which is set once per sheet
	// instance (parent re-renders the sheet when switching providers).
	const methods = $derived(
		provider.authMethods.filter((m) => !m.label.toLowerCase().includes('headless')),
	);

	// Initial step is computed once at mount from the props snapshot. The
	// parent destroys + recreates the sheet on provider change, so we
	// intentionally don't react to `provider` updates here.
	// svelte-ignore state_referenced_locally
	let step = $state<Step>(initialStepFor(provider));

	function initialStepFor(p: ProviderView): Step {
		const list = p.authMethods.filter((m) => !m.label.toLowerCase().includes('headless'));
		if (list.length === 0) return 'api-form'; // bare API-key fallback
		if (list.length === 1) {
			return list[0]!.type === 'oauth' ? 'oauth-code' : 'api-form';
		}
		return 'method-picker';
	}

	let selectedMethod = $state<ProviderAuthMethod | null>(null);
	let apiKey = $state('');
	let authCode = $state('');
	let oauthUrl = $state<string | null>(null);
	let oauthInstructions = $state<string | null>(null);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	let abortController: AbortController | undefined;

	function stopPolling() {
		abortController?.abort();
		abortController = undefined;
	}

	onDestroy(stopPolling);

	const title = $derived.by((): string => {
		if (step === 'method-picker') return `Connect ${provider.name}`;
		if (selectedMethod) return `Login with ${selectedMethod.label}`;
		return `Connect ${provider.name}`;
	});

	const canGoBack = $derived(step !== 'method-picker' && methods.length > 1);

	function selectMethod(m: ProviderAuthMethod) {
		selectedMethod = m;
		apiKey = '';
		authCode = '';
		oauthUrl = null;
		oauthInstructions = null;
		error = null;
		if (m.type === 'oauth') {
			void startOauth(m);
		} else {
			step = 'api-form';
		}
	}

	function goBack() {
		stopPolling();
		selectedMethod = null;
		apiKey = '';
		authCode = '';
		oauthUrl = null;
		oauthInstructions = null;
		error = null;
		submitting = false;
		step = 'method-picker';
	}

	async function startOauth(method: ProviderAuthMethod): Promise<void> {
		submitting = true;
		error = null;
		try {
			const result = await startProviderOauth(provider.id, method.index);
			if (!result.ok || !result.oauth) {
				error = result.message ?? 'OAuth start failed.';
				step = 'method-picker';
				return;
			}
			oauthUrl = result.oauth.url;
			oauthInstructions = result.oauth.instructions ?? null;
			window.open(result.oauth.url, '_blank', 'noopener');

			if (result.oauth.mode === 'auto') {
				// OpenCode's /oauth/callback is a long-poll: it blocks server-side
				// until the OAuth provider completes the device-code or redirect
				// flow (up to ~10 minutes for GitHub device codes), then returns.
				// We make one call and wait — no interval polling.
				step = 'oauth-auto';
				abortController = new AbortController();
				const pid = result.oauth.providerId;
				const methodIndex = result.oauth.methodIndex;

				void oauthCallback(pid, methodIndex, abortController.signal)
					.then((r) => {
						if (step !== 'oauth-auto') return; // sheet closed or back-arrow pressed
						if (r.ok) {
							finish('Signed in successfully.');
						} else {
							error = `Sign-in failed (${r.status}). Try again.`;
							step = 'method-picker';
						}
					})
					.catch((err: unknown) => {
						if (step !== 'oauth-auto') return;
						if (err instanceof DOMException && err.name === 'AbortError') return;
						error = toMessage(err, 'Authorization failed.');
						step = 'method-picker';
					});
			} else {
				step = 'oauth-code';
			}
		} catch (err) {
			error = toMessage(err, 'OAuth start failed.');
			step = 'method-picker';
		} finally {
			submitting = false;
		}
	}

	async function submitApiKey() {
		if (!apiKey.trim()) {
			error = 'Enter an API key.';
			return;
		}
		submitting = true;
		error = null;
		try {
			await submitProviderApiKey(provider.id, apiKey.trim());
			finish('API key saved.');
		} catch (err) {
			error = toMessage(err, 'Request failed.');
		} finally {
			submitting = false;
		}
	}

	async function submitOauthCode() {
		if (!selectedMethod || !authCode.trim()) {
			error = 'Paste the authorization code.';
			return;
		}
		submitting = true;
		error = null;
		try {
			await finishProviderOauth(provider.id, selectedMethod.index, authCode.trim());
			finish('Signed in successfully.');
		} catch (err) {
			error = toMessage(err, 'Request failed.');
		} finally {
			submitting = false;
		}
	}

	function finish(message: string) {
		onaction?.({ ok: true, message, selectedProviderId: provider.id });
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		if (step === 'api-form') void submitApiKey();
		else if (step === 'oauth-code') void submitOauthCode();
	}
</script>

<Drawer open={true} {title} onClose={() => onclose?.()} deferFocusRestore {returnFocus}>
	{#snippet headerStart()}
		{#if canGoBack}
			<button type="button" class="connect-back" onclick={goBack} aria-label="Back">←</button>
		{/if}
	{/snippet}
		{#if error}
			<div class="feedback feedback--error"><span>{error}</span></div>
		{/if}

		{#if step === 'method-picker'}
			<p class="field-hint">Select login method for {provider.name}.</p>
			<div class="auth-method-group">
				{#each methods as method (method.index)}
					<button
						type="button"
						class="auth-method-card"
						onclick={() => selectMethod(method)}
					>
						<span class="method-label">{method.label}</span>
						<span class="method-type">{method.type === 'oauth' ? 'Browser sign-in' : 'API key'}</span>
					</button>
				{/each}
			</div>

		{:else if step === 'api-form'}
			<p class="field-hint">
				Enter your {provider.name} API key to connect your account and use {provider.name} models in OpenCode.
			</p>
			<FormField label="{provider.name} API key" for="connect-apikey">
				<input
					id="connect-apikey"
					type="password"
					class="form-input"
					placeholder="API key"
					bind:value={apiKey}
					disabled={submitting}
					onkeydown={handleKey}
					autocomplete="off"
				/>
			</FormField>

		{:else if step === 'oauth-code'}
			<p class="field-hint">
				Visit
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a href={oauthUrl ?? '#'} target="_blank" rel="noopener" class="text-link">this link</a>
				to collect your authorization code to connect your account and use {provider.name} models in OpenCode.
			</p>
			<FormField label="{selectedMethod?.label ?? 'OAuth'} authorization code" for="connect-code">
				<input
					id="connect-code"
					type="text"
					class="form-input"
					placeholder="Authorization code"
					bind:value={authCode}
					disabled={submitting}
					onkeydown={handleKey}
					autocomplete="off"
				/>
			</FormField>

		{:else if step === 'oauth-auto'}
			{#if oauthInstructions}
				<p class="field-hint">{oauthInstructions}</p>
			{/if}
			{#if oauthUrl}
				<p class="field-hint">
					Open
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
					<a href={oauthUrl} target="_blank" rel="noopener" class="text-link">{oauthUrl}</a>
					to continue.
				</p>
			{/if}
			<p class="field-hint">
				<Spinner />
				Waiting for sign-in to complete…
			</p>
		{/if}
	{#snippet footer()}
		{#if step === 'api-form' || step === 'oauth-code'}
			<button
				type="button"
				class="btn btn-primary"
				disabled={submitting}
				onclick={() => step === 'api-form' ? void submitApiKey() : void submitOauthCode()}
			>
				{#if submitting}<Spinner />{/if}
				Continue
			</button>
		{/if}
	{/snippet}
</Drawer>

<style>
	.connect-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		background: none;
		border: none;
		border-radius: 2px;
		color: var(--s-ink-2);
		font-size: var(--s-type-voice);
		cursor: pointer;
		flex-shrink: 0;
	}
	.connect-back:hover {
		color: var(--s-ink);
	}
	.connect-back:focus-visible {
		outline: var(--s-hair) solid var(--s-seal);
		outline-offset: 2px;
	}
	.auth-method-group {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-2);
	}

	.auth-method-card {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-1);
		padding: var(--s-sp-3) var(--s-sp-4);
		background: none;
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		cursor: pointer;
		text-align: left;
		font-family: inherit;
	}

	.auth-method-card:hover {
		border-color: var(--s-ink-2);
		background: color-mix(in srgb, var(--s-ink) 4%, var(--s-paper));
	}

	.method-label {
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink);
	}

	.method-type {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-3);
	}
</style>
