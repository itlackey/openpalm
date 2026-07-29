<script lang="ts">
	import { onMount } from 'svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import {
		applyChanges,
		applyServiceUpdate,
		fetchVersions,
		patchVersions,
		updateUiBuild,
		type UpdateChannel,
		type VersionKey
	} from '$lib/api.js';
	import type { ServiceEntry } from '$lib/types.js';
	import {
		desktopNotifyEnabled,
		desktopReplyPreviewEnabled,
		setDesktopNotifyEnabled,
		setDesktopReplyPreviewEnabled
	} from '$lib/desktop-notifications.js';

	const VERSION_FIELDS: Array<{ key: VersionKey; label: string }> = [
		{ key: 'OP_ASSISTANT_VERSION', label: 'Assistant image' },
		{ key: 'OP_GUARDIAN_VERSION', label: 'Guardian image' },
		{ key: 'OP_PORTAL_VERSION', label: 'Portal image' },
		{ key: 'OP_VOICE_VERSION', label: 'Voice image' }
	];

	const emptyConfigured = (): Record<VersionKey, string> => ({
		OP_ASSISTANT_VERSION: '',
		OP_GUARDIAN_VERSION: '',
		OP_PORTAL_VERSION: '',
		OP_VOICE_VERSION: ''
	});

	let {
		containers,
		dockerAvailable,
		onRefresh
	}: {
		containers: ServiceEntry[];
		dockerAvailable: boolean;
		onRefresh: () => Promise<void>;
	} = $props();

	let loading = $state(true);
	let loadError = $state('');
	let configured = $state<Record<VersionKey, string>>(emptyConfigured());
	let channel = $state<UpdateChannel>('latest');

	type Operation =
		| { kind: 'service'; service: string }
		| { kind: 'stack' | 'configuration' | 'ui' }
		| null;
	type Notice = { tone: 'success' | 'error'; text: string } | null;
	let operation = $state<Operation>(null);
	let notice = $state<Notice>(null);

	let inElectron = $state(false);
	let notificationsEnabled = $state(false);
	let replyPreviewEnabled = $state(false);
	let launchOnLoginSupported = $state(false);
	let launchOnLoginEnabled = $state(false);
	let launchOnLoginSaving = $state(false);

	const busy = $derived(operation !== null);

	onMount(() => {
		inElectron = typeof window.openpalm !== 'undefined';
		notificationsEnabled = desktopNotifyEnabled();
		replyPreviewEnabled = desktopReplyPreviewEnabled();
		void loadVersions();
		void hydrateLaunchOnLogin();
	});

	async function loadVersions(): Promise<void> {
		loading = true;
		loadError = '';
		try {
			const data = await fetchVersions();
			configured = { ...data.configured };
			channel = data.channel;
		} catch (error) {
			loadError = `Failed to load versions: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			loading = false;
		}
	}

	async function hydrateLaunchOnLogin(): Promise<void> {
		const status = await window.openpalm?.launchOnLoginStatus?.();
		if (!status) return;
		launchOnLoginSupported = status.supported;
		launchOnLoginEnabled = status.enabled;
	}

	async function updateService(service: string): Promise<void> {
		if (busy) return;
		operation = { kind: 'service', service };
		notice = null;
		try {
			await applyServiceUpdate(service);
			notice = { tone: 'success', text: `Updated ${service}.` };
			await onRefresh();
		} catch (error) {
			notice = { tone: 'error', text: error instanceof Error ? error.message : String(error) };
		} finally {
			operation = null;
		}
	}

	async function updateStack(): Promise<void> {
		if (busy) return;
		operation = { kind: 'stack' };
		notice = null;
		try {
			await applyChanges();
			notice = { tone: 'success', text: 'OpenPalm stack update completed.' };
			await onRefresh();
		} catch (error) {
			notice = { tone: 'error', text: error instanceof Error ? error.message : String(error) };
		} finally {
			operation = null;
		}
	}

	async function saveConfiguration(): Promise<void> {
		if (busy) return;
		const versions = emptyConfigured();
		for (const field of VERSION_FIELDS) {
			const value = configured[field.key].trim();
			if (!value) {
				notice = { tone: 'error', text: `${field.key} must not be empty.` };
				return;
			}
			versions[field.key] = value;
		}

		operation = { kind: 'configuration' };
		notice = null;
		try {
			await patchVersions(versions, channel);
			configured = versions;
			notice = { tone: 'success', text: 'Configured image tags saved.' };
		} catch (error) {
			notice = { tone: 'error', text: error instanceof Error ? error.message : String(error) };
		} finally {
			operation = null;
		}
	}

	async function updateUi(): Promise<void> {
		if (busy) return;
		operation = { kind: 'ui' };
		notice = null;
		try {
			const result = await updateUiBuild();
			if (result.redownloadRequired) {
				notice = { tone: 'success', text: `A newer UI needs OpenPalm desktop harness v${result.requiredHarnessContract ?? 'newer'}. Re-download the desktop app to update.` };
			} else if (!result.updated) {
				notice = { tone: 'success', text: result.latestVersion
					? `No UI update was installed. Current channel version: ${result.latestVersion}.`
					: 'No UI update was installed.' };
			} else if (result.pendingRestart) {
				void window.openpalm?.restartUiServer?.();
				notice = { tone: 'success', text: 'UI updated. Restarting...' };
			} else if (result.restarting) {
				setTimeout(() => {
					location.href = '/';
				}, 4_000);
				notice = { tone: 'success', text: 'UI updated. Reloading shortly...' };
			} else {
				notice = { tone: 'success', text: 'UI downloaded. Restart the admin UI to apply it.' };
			}
		} catch (error) {
			notice = { tone: 'error', text: error instanceof Error ? error.message : String(error) };
		} finally {
			operation = null;
		}
	}

	async function onLaunchOnLoginChange(event: Event): Promise<void> {
		const enabled = (event.currentTarget as HTMLInputElement).checked;
		if (!window.openpalm?.setLaunchOnLogin) {
			launchOnLoginEnabled = false;
			return;
		}
		launchOnLoginSaving = true;
		try {
			const status = await window.openpalm.setLaunchOnLogin(enabled);
			launchOnLoginSupported = status.supported;
			launchOnLoginEnabled = status.enabled;
		} finally {
			launchOnLoginSaving = false;
		}
	}
</script>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<div>
			<h2>Updates</h2>
			<p class="panel-subtitle">
				Pull and recreate real Compose services, or refresh the complete OpenPalm stack.
			</p>
		</div>
		<div class="header-actions">
			<button
				class="btn btn-primary"
				onclick={updateStack}
				disabled={busy}
				aria-busy={operation?.kind === 'stack'}
			>
				{#if operation?.kind === 'stack'}<Spinner /> Updating stack...{:else}Update OpenPalm stack{/if}
			</button>
			<button
				class="btn btn-outline"
				onclick={updateUi}
				disabled={busy}
				aria-busy={operation?.kind === 'ui'}
			>
				{#if operation?.kind === 'ui'}<Spinner /> Updating UI...{:else}Update UI{/if}
			</button>
		</div>
	</div>

	{#if notice}
		<p class="msg msg-{notice.tone}" role={notice.tone === 'error' ? 'alert' : 'status'}>
			{notice.text}
		</p>
	{/if}

	<div class="panel-body">
		{#if loadError}
			<p class="msg msg-error" role="alert">{loadError}</p>
		{/if}

		{#if loading}
			<p class="loading-line"><Spinner /> Loading container versions...</p>
		{:else}
			<section aria-labelledby="containers-heading">
				<div class="section-title-row">
					<div>
						<h3 id="containers-heading" class="section-heading">Compose containers</h3>
						<p class="section-desc">Running image data comes directly from Docker Compose.</p>
					</div>
					{#if !dockerAvailable}<span class="docker-offline">Docker unavailable</span>{/if}
				</div>

				{#if containers.length === 0}
					<p class="empty-state">No Compose containers were found.</p>
				{:else}
					<div class="table-wrap">
						<table class="container-table">
							<thead>
								<tr>
									<th scope="col">Service</th>
									<th scope="col">Running image</th>
									<th scope="col">State</th>
									<th scope="col">Health</th>
									<th scope="col"><span class="sr-only">Actions</span></th>
								</tr>
							</thead>
							<tbody>
								{#each containers as container (container.service)}
									<tr>
										<td><strong>{container.service}</strong></td>
										<td><code>{container.docker?.Image || 'unknown'}</code></td>
										<td>{container.state}</td>
										<td>{container.docker?.Health || 'not reported'}</td>
										<td class="action-cell">
											<button
												class="btn btn-sm btn-outline"
												onclick={() => updateService(container.service)}
												disabled={busy || container.state !== 'running'}
												aria-busy={operation?.kind === 'service' && operation.service === container.service}
												aria-label="Update {container.service}"
											>
												{#if operation?.kind === 'service' && operation.service === container.service}<Spinner
													/>{:else if container.state === 'running'}Update{:else}Stopped{/if}
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>

			<section class="configuration" aria-labelledby="configuration-heading">
				<details>
					<summary id="configuration-heading">Advanced image tags</summary>
					<p class="section-desc">
						Most installations should keep these values set to <code>latest</code>.
					</p>

					<form
						onsubmit={(event) => {
							event.preventDefault();
							void saveConfiguration();
						}}
					>
						<div class="version-grid">
							{#each VERSION_FIELDS as field (field.key)}
								<label class="version-field">
									<span>{field.label}</span>
									<code>{field.key}</code>
									<input
										type="text"
										autocomplete="off"
										spellcheck="false"
										required
										bind:value={configured[field.key]}
										aria-label={field.key}
									/>
								</label>
							{/each}
						</div>

						<div class="config-actions">
							<label class="channel-field">
								<span>UI update channel</span>
								<select bind:value={channel} aria-label="UI update channel">
									<option value="latest">Stable</option>
									<option value="next">Prerelease</option>
								</select>
							</label>
							<button
								class="btn btn-outline"
								type="submit"
								disabled={busy}
								aria-busy={operation?.kind === 'configuration'}
							>
								{#if operation?.kind === 'configuration'}<Spinner /> Saving...{:else}Save advanced settings{/if}
							</button>
						</div>
					</form>
				</details>
			</section>
		{/if}

		{#if inElectron}
			<section class="desktop-settings" aria-labelledby="desktop-settings-title">
				<h3 id="desktop-settings-title" class="section-heading">Desktop settings</h3>

				<div class="desktop-setting-row">
					<div class="setting-label">Launch on login</div>
					<label class="desktop-toggle">
						<input
							type="checkbox"
							checked={launchOnLoginEnabled}
							disabled={!launchOnLoginSupported || launchOnLoginSaving}
							onchange={onLaunchOnLoginChange}
						/>
						<span>Start OpenPalm automatically when you sign in on this device.</span>
					</label>
					<p class="setting-hint">
						{#if launchOnLoginSupported}
							Uses the native desktop login-item integration for this platform.
						{:else}
							Not wired on this platform yet. The current desktop build only exposes this safely on
							macOS and Windows.
						{/if}
					</p>
				</div>

				<div class="desktop-setting-row">
					<div class="setting-label">Desktop notifications</div>
					{#if typeof window.openpalm?.notify === 'function'}
						<label class="desktop-toggle">
							<input
								type="checkbox"
								checked={notificationsEnabled}
								onchange={(event) => {
									notificationsEnabled = (event.currentTarget as HTMLInputElement).checked;
									setDesktopNotifyEnabled(notificationsEnabled);
									if (!notificationsEnabled) {
										replyPreviewEnabled = false;
										setDesktopReplyPreviewEnabled(false);
									}
								}}
							/>
							<span
								>Notify when the assistant replies or errors while the app is in the background.</span
							>
						</label>
						<label class="desktop-toggle desktop-toggle--nested">
							<input
								type="checkbox"
								checked={replyPreviewEnabled}
								disabled={!notificationsEnabled}
								onchange={(event) => {
									replyPreviewEnabled = (event.currentTarget as HTMLInputElement).checked;
									setDesktopReplyPreviewEnabled(replyPreviewEnabled);
								}}
							/>
							<span>Include reply preview in the notification body.</span>
						</label>
						<p class="setting-hint">
							Reply previews stay off by default because desktop notifications can persist outside
							the app.
						</p>
					{:else}
						<label class="desktop-toggle">
							<input type="checkbox" disabled />
							<span
								>Notify when the assistant replies or errors while the app is in the background.</span
							>
						</label>
						<label class="desktop-toggle desktop-toggle--nested">
							<input type="checkbox" disabled />
							<span>Include reply preview in the notification body.</span>
						</label>
						<p class="setting-hint">
							Desktop notifications are available in the OpenPalm desktop app.
						</p>
					{/if}
				</div>
			</section>
		{/if}
	</div>
</div>

<style>
	.panel-header,
	.section-title-row,
	.config-actions {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--s-sp-4);
		flex-wrap: wrap;
	}

	.panel-header {
		margin-bottom: var(--s-sp-4);
	}

	.header-actions {
		display: flex;
		gap: var(--s-sp-3);
		flex-wrap: wrap;
	}

	.section-heading,
	.version-field code {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
	}

	.section-heading {
		color: var(--s-ink-3);
		font-weight: 400;
		margin: 0 0 var(--s-sp-2);
	}

	.section-desc,
	.empty-state,
	.setting-hint {
		color: var(--s-ink-3);
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		line-height: 1.5;
	}

	.section-desc {
		margin: 0 0 var(--s-sp-3);
	}

	.loading-line {
		display: flex;
		align-items: center;
		gap: var(--s-sp-2);
		color: var(--s-ink-3);
	}

	.msg {
		margin: var(--s-sp-2) 0;
		padding: var(--s-sp-2) var(--s-sp-3);
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
	}

	.msg-success {
		color: var(--s-moss, #16a34a);
		border-color: var(--s-moss, #16a34a);
	}

	.msg-error,
	.docker-offline {
		color: var(--s-seal, #ef4444);
		border-color: var(--s-seal, #ef4444);
	}

	.docker-offline {
		border: var(--s-hair) solid;
		border-radius: 2px;
		padding: var(--s-sp-1) var(--s-sp-2);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		text-transform: uppercase;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.container-table {
		width: 100%;
		min-width: 42rem;
		border-collapse: collapse;
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
	}

	.container-table th,
	.container-table td {
		padding: var(--s-sp-2) var(--s-sp-3);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		text-align: left;
		vertical-align: middle;
	}

	.container-table th {
		color: var(--s-ink-3);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
	}

	.container-table code,
	.version-field input {
		color: var(--s-ink-2);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
	}

	.action-cell {
		text-align: right !important;
	}

	.btn-sm {
		display: inline-flex;
		align-items: center;
		gap: var(--s-sp-1);
		padding: var(--s-sp-1) var(--s-sp-3);
		font-size: var(--s-type-deed);
	}

	.configuration,
	.desktop-settings {
		margin-top: var(--s-sp-6);
		padding-top: var(--s-sp-4);
		border-top: var(--s-hair) solid var(--s-line);
	}

	.configuration summary {
		cursor: pointer;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	.version-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--s-sp-3) var(--s-sp-4);
	}

	.version-field,
	.channel-field {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-1);
		color: var(--s-ink);
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
	}

	.version-field code {
		color: var(--s-ink-3);
	}

	.version-field input,
	.channel-field select {
		min-width: 0;
		padding: var(--s-sp-2);
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		background: var(--s-paper);
		color: var(--s-ink);
	}

	.config-actions {
		align-items: flex-end;
		margin-top: var(--s-sp-4);
	}

	.channel-field {
		min-width: 12rem;
	}

	.desktop-setting-row {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-2);
		padding: var(--s-sp-3) 0;
		border-bottom: var(--s-hair) solid var(--s-line-soft);
	}

	.setting-label,
	.desktop-toggle {
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink);
	}

	.desktop-toggle {
		display: flex;
		align-items: flex-start;
		gap: var(--s-sp-3);
		cursor: pointer;
	}

	.desktop-toggle--nested {
		margin-left: var(--s-sp-6);
	}

	.setting-hint {
		margin: 0;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	@media (max-width: 700px) {
		.version-grid {
			grid-template-columns: 1fr;
		}

		.header-actions,
		.header-actions .btn,
		.config-actions .btn {
			width: 100%;
		}
	}
</style>
