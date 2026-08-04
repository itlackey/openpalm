<script lang="ts">
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onDestroy, onMount, tick } from 'svelte';
	import { buildChatPath } from '$lib/conversation-paths.js';
	import {
		getConnectionStorageMode,
		getConnectionStore,
		getSecretStore,
		type ConnectionStorageMode
	} from '$lib/connections/boot.js';
	import {
		pairingFragment,
		saveVerifiedConnection,
		verifyConnectionCandidate,
		type ConnectionCandidateInput,
		type VerifyConnectionCandidateResult,
		type VerifiedConnectionCandidate
	} from '$lib/connections/onboarding.js';
	import { parsePairingCode } from '$lib/connections/pairing.js';
	import { connectionSecretsEncryptedAtRest } from '$lib/connections/secrets.js';
	import { newConnectionId } from '$lib/connections/store.js';
	import { TLS_GUIDE_URL } from '$lib/connections/url-policy.js';
	import { endpointsService as connectionsService } from '$lib/endpoints-state.svelte.js';
	import { getRuntimeContext, hasCapability } from '$lib/runtime-context.svelte.js';

	type EntryMode = 'pairing' | 'manual';

	let mode = $state<EntryMode>('pairing');
	let pairingCode = $state('');
	let formLabel = $state('');
	let formUrl = $state('');
	let formUsername = $state('');
	let formPassword = $state('');
	let submitting = $state(false);
	let errorMessage = $state('');
	let guideUrl = $state<string | null>(null);
	let storageMode = $state<ConnectionStorageMode | 'checking'>('checking');
	let disclosureCandidate = $state<VerifiedConnectionCandidate | null>(null);
	let pairingInput = $state<HTMLTextAreaElement>();
	let manualInput = $state<HTMLInputElement>();
	let disclosureHeading = $state<HTMLHeadingElement>();
	const runtimeContext = getRuntimeContext();
	const onboarding = page.url.searchParams.get('onboarding') === '1';
	let cancelDestination = $state<string | null>(onboarding ? null : resolve('/connections'));
	let persisting = $state(false);
	let operationGeneration = 0;
	let destroyed = false;

	// The install-or-connect question, shown once at the top of onboarding. Only
	// a host-capable process can offer to install — a phone or a container-served
	// UI has no stack to put anywhere — so everyone else goes straight to the
	// connect form, exactly as before.
	let choiceMade = $state(false);
	const showChoice = $derived(
		onboarding && !choiceMade && hasCapability(runtimeContext, 'host:setup'),
	);

	/**
	 * A browser that already has a connection does not need to be asked how to
	 * begin. The landing resolver usually catches this, but it reads a client
	 * hint cookie that a fresh profile or a cleared jar will not have — so the
	 * page confirms against the real store and moves on.
	 */
	async function restoreActiveConnection(): Promise<void> {
		if (!onboarding) return;
		// Entirely best-effort: all this saves a returning browser is one screen,
		// and the page behind it works without it. A store that cannot answer —
		// unavailable, mid-migration, or simply empty — must leave the user on
		// onboarding rather than surfacing as an unhandled rejection.
		try {
			await connectionsService.load();
			if (destroyed || connectionsService.error) return;
			const active = (connectionsService.endpoints ?? []).find(
				(connection) => connection.id === connectionsService.activeId,
			);
			if (!active) return;
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- buildChatPath returns the validated internal Chat route
			await goto(buildChatPath(null, active.id), { replaceState: true });
		} catch {
			// Stay on onboarding; the user can connect from here.
		}
	}

	onMount(() => {
		consumePairDeepLink();
		void focusCurrentInput();
		void initializeStorageMode();
		void initializeCancelDestination();
		void restoreActiveConnection();
	});

	onDestroy(() => {
		destroyed = true;
		operationGeneration += 1;
	});

	async function initializeCancelDestination(): Promise<void> {
		if (!onboarding) return;
		// The root layout resolves the display mode on mount. Waiting one frame
		// prevents standalone clients from briefly receiving host navigation.
		await new Promise<void>((done) => requestAnimationFrame(() => done()));
		if (!destroyed && hasCapability(runtimeContext, 'host:setup')) {
			// Back goes to this page's own choice screen — the welcome route it
			// used to point at was retired into it.
			cancelDestination = null;
		}
	}

	async function focusCurrentInput(): Promise<void> {
		await tick();
		if (mode === 'manual') manualInput?.focus();
		else pairingInput?.focus();
	}

	async function initializeStorageMode(): Promise<void> {
		storageMode = await getConnectionStorageMode();
	}

	function consumePairDeepLink(): void {
		const consumed = pairingFragment(new URL(window.location.href));
		if (consumed.code === null) return;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- sanitized same-origin path with the credential fragment removed
		replaceState(consumed.cleanPath, {});
		mode = 'pairing';
		pairingCode = consumed.code;
		errorMessage = '';
		guideUrl = null;
		disclosureCandidate = null;
		void focusCurrentInput();
	}

	async function showManual(): Promise<void> {
		mode = 'manual';
		errorMessage = '';
		guideUrl = null;
		disclosureCandidate = null;
		await focusCurrentInput();
	}

	async function showPairing(): Promise<void> {
		mode = 'pairing';
		errorMessage = '';
		guideUrl = null;
		disclosureCandidate = null;
		await focusCurrentInput();
	}

	function friendlyVerificationError(
		result: Extract<VerifyConnectionCandidateResult, { ok: false }>
	): string {
		switch (result.reason) {
			case 'credentials-rejected':
				return 'OpenPalm did not accept these sign-in details. Check them or ask for a new pairing code.';
			case 'wrong-endpoint':
				return 'This address did not respond as OpenPalm. Check the address and try again.';
			case 'rate-limited':
				return 'OpenPalm is receiving too many requests. Wait a moment and try again.';
			case 'target-not-ready':
				return 'OpenPalm is still starting. Wait a moment and try again.';
			case 'mixed-content':
				return 'This page cannot connect safely to that address. Use an address beginning with https://.';
			case 'network-uncertain':
				return 'This browser could not reach OpenPalm. Check the address and network connection.';
			case 'invalid-url':
				return 'Check the address. It should begin with http:// or https:// and contain only the OpenPalm address.';
			case 'invalid-input':
				return result.message;
		}
	}

	async function submitPairing(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (submitting) return;
		const parsed = parsePairingCode(pairingCode);
		if (!parsed.ok) {
			errorMessage = parsed.error;
			guideUrl = null;
			return;
		}
		await verifyAndSave({
			label: parsed.payload.label?.trim() || 'My OpenPalm',
			baseUrl: parsed.payload.url,
			auth: {
				mode: 'basic',
				username: parsed.payload.username,
				password: parsed.payload.secret
			}
		});
	}

	async function submitManual(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (submitting) return;
		const password = formPassword;
		await verifyAndSave({
			label: formLabel,
			baseUrl: formUrl,
			auth: password
				? { mode: 'basic', username: formUsername.trim() || 'opencode', password }
				: { mode: 'none' }
		});
	}

	async function verifyAndSave(input: ConnectionCandidateInput): Promise<void> {
		const operation = ++operationGeneration;
		submitting = true;
		errorMessage = '';
		guideUrl = null;
		disclosureCandidate = null;
		try {
			const verified = await verifyConnectionCandidate(input);
			if (operation !== operationGeneration) return;
			if (!verified.ok) {
				errorMessage = friendlyVerificationError(verified);
				guideUrl =
					verified.guideUrl ?? (verified.reason === 'mixed-content' ? TLS_GUIDE_URL : null);
				return;
			}

			storageMode = await getConnectionStorageMode();
			if (operation !== operationGeneration) return;
			if (
				verified.candidate.auth.mode === 'basic' &&
				storageMode === 'persistent' &&
				!connectionSecretsEncryptedAtRest()
			) {
				disclosureCandidate = verified.candidate;
				await tick();
				if (operation !== operationGeneration) return;
				disclosureHeading?.focus();
				return;
			}
			await persistCandidate(verified.candidate, operation);
		} finally {
			if (operation === operationGeneration) submitting = false;
		}
	}

	async function persistCandidate(
		candidate: VerifiedConnectionCandidate,
		operation: number
	): Promise<void> {
		if (operation !== operationGeneration) return;
		persisting = true;
		try {
			const saved = await saveVerifiedConnection(candidate, {
				store: getConnectionStore(),
				secrets: getSecretStore(),
				activate: (id, expectedActiveId) => connectionsService.activate(id, expectedActiveId),
				refresh: async () => {
					await connectionsService.load(true);
					if (connectionsService.error) throw new Error('Connection refresh failed.');
				},
				createId: newConnectionId
			});
			if (operation !== operationGeneration) return;
			if (!saved.ok) {
				errorMessage = saved.error;
				return;
			}
			disclosureCandidate = null;
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- buildChatPath returns the validated internal Chat route
			await goto(buildChatPath(null, saved.connection.id), { replaceState: true });
		} finally {
			if (operation === operationGeneration) persisting = false;
		}
	}

	async function continueWithUnprotectedStorage(): Promise<void> {
		if (!disclosureCandidate || submitting) return;
		const operation = ++operationGeneration;
		submitting = true;
		errorMessage = '';
		try {
			await persistCandidate(disclosureCandidate, operation);
		} finally {
			if (operation === operationGeneration) submitting = false;
		}
	}

	async function cancelDisclosure(): Promise<void> {
		disclosureCandidate = null;
		await focusCurrentInput();
	}

	/** Whether Back returns to this page's own choice screen rather than leaving. */
	const backToChoice = $derived(
		onboarding && choiceMade && hasCapability(runtimeContext, 'host:setup'),
	);

	async function cancelWizard(): Promise<void> {
		if (persisting) return;
		operationGeneration += 1;
		submitting = false;
		if (backToChoice) {
			// The welcome choice was retired into this page, so Back steps back a
			// screen instead of navigating to a route that no longer exists.
			choiceMade = false;
			return;
		}
		if (!cancelDestination) return;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- destination is selected from resolved internal routes above
		await goto(cancelDestination);
	}
</script>

<svelte:head>
	<title>Connect to OpenPalm</title>
</svelte:head>

<svelte:window onhashchange={consumePairDeepLink} />

<main class="onboarding-shell">
	<section class="onboarding-card" aria-labelledby="onboarding-title">
		{#if showChoice}
			<!-- The install-or-connect question, asked on the surface its answer
			     leads to. Both routes are first-class: connecting to an OpenPalm
			     that already exists is not a fallback for people who failed to
			     install one, so the cards carry the same weight and each says
			     plainly what it costs. Only a host-capable process can offer the
			     left-hand one at all — a phone or a container-served UI has no
			     stack to install. -->
			<header>
				<span class="eyebrow">Your private assistant</span>
				<h1 id="onboarding-title">Welcome to OpenPalm</h1>
				<p>Choose how you want to begin. You can change this later.</p>
			</header>
			<div class="choices">
				<a class="choice" href={runtimeContext.routes?.setup ?? resolve('/setup')}>
					<strong>Set up OpenPalm on this computer</strong>
					<span>Run your own private assistant here. We will guide you through the setup.</span>
					<small>Recommended</small>
				</a>
				<button class="choice" type="button" onclick={() => { choiceMade = true; }}>
					<strong>Connect to an existing OpenPalm</strong>
					<span>Nothing to install — connect with an address or a pairing code.</span>
					<small>No install needed</small>
				</button>
			</div>
		{:else}
		{#if (cancelDestination || backToChoice) && !disclosureCandidate}
			<button class="back-link" type="button" onclick={cancelWizard} disabled={persisting}
				>Back</button
			>
		{/if}
		<header>
			<span class="eyebrow">This device</span>
			<h1 id="onboarding-title">Connect to OpenPalm</h1>
			<p>Use a pairing code for the quickest setup. Nothing is saved until the connection works.</p>
		</header>

		{#if storageMode === 'session-only'}
			<div class="notice" role="status">
				Browser storage is unavailable. This connection is session-only and will be lost when this
				page is reloaded or closed.
			</div>
		{/if}

		{#if disclosureCandidate}
			<section class="disclosure" role="alert" aria-labelledby="storage-warning-title">
				<h2 id="storage-warning-title" tabindex="-1" bind:this={disclosureHeading}>
					This browser cannot protect saved passwords
				</h2>
				<p>
					If you continue, this connection password will be saved on this device without encryption.
					Continue only on a device you trust.
				</p>
				{#if errorMessage}<div class="error" role="alert">{errorMessage}</div>{/if}
				<div class="actions">
					<button
						type="button"
						class="primary"
						onclick={continueWithUnprotectedStorage}
						disabled={submitting}
					>
						{submitting ? 'Saving…' : 'Save anyway'}
					</button>
					<button type="button" onclick={cancelDisclosure} disabled={submitting}>Back</button>
				</div>
			</section>
		{:else if mode === 'pairing'}
			<form onsubmit={submitPairing} novalidate>
				<label for="pairing-code">Pairing code</label>
				<textarea
					id="pairing-code"
					bind:this={pairingInput}
					bind:value={pairingCode}
					placeholder="openpalm-pair:…"
					rows="4"
					autocomplete="off"
					spellcheck="false"
					required
				></textarea>
				<p class="hint">Paste the code shown by the OpenPalm you want to use.</p>

				{#if errorMessage}
					<div class="error" role="alert">
						<span>{errorMessage}</span>
						{#if guideUrl}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external URL supplied by the connection policy -->
							<a href={guideUrl} target="_blank" rel="noopener noreferrer"
								>Open the HTTPS setup guide</a
							>
						{/if}
					</div>
				{/if}

				<div class="actions stacked">
					<button type="submit" class="primary" disabled={submitting || !pairingCode.trim()}>
						{submitting ? 'Checking…' : 'Connect'}
					</button>
					<button type="button" class="link-button" onclick={showManual} disabled={submitting}>
						Enter an address instead
					</button>
				</div>
			</form>
		{:else}
			<form onsubmit={submitManual} novalidate>
				<label for="connection-label">Name</label>
				<input
					id="connection-label"
					bind:this={manualInput}
					bind:value={formLabel}
					placeholder="Home"
					autocomplete="off"
					required
				/>

				<label for="connection-url">Address</label>
				<input
					id="connection-url"
					type="url"
					bind:value={formUrl}
					placeholder="https://openpalm.example/oc"
					autocomplete="url"
					required
				/>

				<div class="optional-heading">Sign-in details <span>optional</span></div>
				<label for="connection-username">Username</label>
				<input
					id="connection-username"
					bind:value={formUsername}
					placeholder="opencode"
					autocomplete="username"
				/>

				<label for="connection-password">Password</label>
				<input
					id="connection-password"
					type="password"
					bind:value={formPassword}
					autocomplete="new-password"
				/>

				{#if errorMessage}
					<div class="error" role="alert">
						<span>{errorMessage}</span>
						{#if guideUrl}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external URL supplied by the connection policy -->
							<a href={guideUrl} target="_blank" rel="noopener noreferrer"
								>Open the HTTPS setup guide</a
							>
						{/if}
					</div>
				{/if}

				<div class="actions">
					<button type="submit" class="primary" disabled={submitting}>
						{submitting ? 'Checking…' : 'Connect'}
					</button>
					<button type="button" onclick={showPairing} disabled={submitting}
						>Back to pairing code</button
					>
				</div>
			</form>
		{/if}
		{/if}
	</section>
</main>

<style>
	.onboarding-shell {
		min-height: 100%;
		display: grid;
		place-items: center;
		padding: var(--s-sp-5);
		background:
			radial-gradient(
				circle at 15% 10%,
				color-mix(in srgb, var(--s-seal) 10%, transparent),
				transparent 34rem
			),
			var(--s-paper-deep);
	}

	.onboarding-card {
		box-sizing: border-box;
		width: min(100%, 34rem);
		padding: clamp(var(--s-sp-4), 6vw, var(--s-sp-6));
		border: var(--s-hair) solid var(--s-line);
		border-top: 4px solid var(--s-seal);
		border-radius: 3px;
		background: var(--s-paper);
		box-shadow: 0 18px 45px color-mix(in srgb, var(--s-ink) 12%, transparent);
	}

	header {
		margin-bottom: var(--s-sp-5);
	}

	/* Both first-run routes get one treatment. Styling the connect card as the
	   lesser option made it read as a consolation prize; the badges carry the
	   difference in meaning instead. */
	.choices {
		display: grid;
		gap: 14px;
	}

	.choice {
		position: relative;
		display: grid;
		gap: 7px;
		padding: 22px;
		border: 2px solid var(--s-moss);
		border-radius: 12px;
		background: color-mix(in srgb, var(--s-moss) 9%, var(--s-paper));
		color: var(--s-ink);
		font: inherit;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		transition: border-color 120ms ease, transform 120ms ease;
	}

	.choice:hover,
	.choice:focus-visible {
		border-color: var(--s-ink);
		transform: translateY(-2px);
	}

	.choice strong {
		padding-right: 130px;
		font-size: 1.08rem;
	}

	.choice span {
		color: var(--s-ink-2);
		line-height: 1.5;
	}

	.choice small {
		position: absolute;
		top: 20px;
		right: 20px;
		color: var(--s-moss);
		font-weight: 700;
	}

	@media (max-width: 520px) {
		.choice strong {
			padding-right: 0;
		}
		.choice small {
			position: static;
			order: -1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.choice {
			transition: none;
		}
	}

	.eyebrow {
		color: var(--s-seal);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-deed);
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	h1,
	h2,
	p {
		margin-top: 0;
	}

	h1 {
		margin-bottom: var(--s-sp-2);
	}

	header p,
	.hint,
	.disclosure p {
		color: var(--s-ink-3);
	}

	form,
	.disclosure {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-2);
	}

	label,
	.optional-heading {
		margin-top: var(--s-sp-2);
		font-size: var(--s-type-deed);
		font-weight: 700;
	}

	.optional-heading {
		display: flex;
		align-items: center;
		gap: var(--s-sp-2);
		margin-top: var(--s-sp-4);
		padding-top: var(--s-sp-3);
		border-top: var(--s-hair) solid var(--s-line);
	}

	.optional-heading span {
		color: var(--s-ink-3);
		font-weight: 400;
	}

	input,
	textarea,
	button {
		box-sizing: border-box;
		min-height: 44px;
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		font: inherit;
	}

	input,
	textarea {
		width: 100%;
		min-width: 0;
		padding: var(--s-sp-2) var(--s-sp-3);
		color: var(--s-ink);
		background: var(--s-paper);
	}

	textarea {
		resize: vertical;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-deed);
	}

	button {
		padding: var(--s-sp-2) var(--s-sp-4);
		color: var(--s-ink);
		background: var(--s-paper);
		cursor: pointer;
	}

	button.primary {
		border-color: var(--s-seal);
		color: var(--s-paper);
		background: var(--s-seal);
		font-weight: 700;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.hint {
		margin: 0 0 var(--s-sp-2);
		font-size: var(--s-type-deed);
	}

	.actions {
		display: flex;
		gap: var(--s-sp-2);
		margin-top: var(--s-sp-3);
	}

	.actions.stacked {
		flex-direction: column;
	}

	.link-button {
		border-color: transparent;
		color: var(--s-seal);
		background: transparent;
	}

	.notice,
	.error,
	.disclosure {
		margin-bottom: var(--s-sp-3);
		padding: var(--s-sp-3);
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
	}

	.notice {
		background: var(--s-paper-deep);
	}

	.error,
	.disclosure {
		border-color: color-mix(in srgb, var(--s-seal) 30%, var(--s-line));
		background: color-mix(in srgb, var(--s-seal) 7%, var(--s-paper));
	}

	.error {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-2);
		color: var(--s-seal);
	}

	.error a {
		color: inherit;
		font-weight: 700;
	}

	.back-link {
		display: inline-block;
		margin-bottom: var(--s-sp-3);
		min-height: auto;
		padding: 0;
		border: 0;
		color: var(--s-ink-2);
		background: transparent;
		font-weight: 700;
		text-decoration: none;
	}

	.back-link:focus-visible,
	.back-link:hover {
		color: var(--s-seal);
		text-decoration: underline;
	}

	@media (prefers-reduced-motion: reduce) {
		.onboarding-shell,
		.onboarding-card,
		button,
		input,
		textarea {
			scroll-behavior: auto;
			transition: none;
			animation: none;
		}
	}

	@media (max-width: 480px) {
		.onboarding-shell {
			place-items: start center;
			padding: var(--s-sp-3);
		}

		.onboarding-card {
			padding: var(--s-sp-4);
		}

		.actions:not(.stacked) {
			flex-direction: column;
		}
	}
</style>
