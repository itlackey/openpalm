<script lang="ts">
	import { apiGet, apiPost } from '$lib/api';
	import { showToast } from '$lib/stores/toast';
	import HealthBadge from '$lib/components/HealthBadge.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import type { ChannelInfo } from '$lib/types';

	type HealthResult = { ok: boolean; time?: string; error?: string };

	let loading = $state(true);
	let channels = $state<ChannelInfo[]>([]);
	let channelHealth = $state<Record<string, HealthResult>>({});

	/** Track which cards have their config section expanded */
	let expandedCards = $state<Record<string, boolean>>({});

	/** Edited config values per channel service, keyed by service then field key */
	let editedConfigs = $state<Record<string, Record<string, string>>>({});

	/** Whether to restart the container after saving config */
	let restartAfterSave = $state<Record<string, boolean>>({});

	/** Track in-flight operations per channel */
	let savingConfig = $state<Record<string, boolean>>({});
	let togglingAccess = $state<Record<string, boolean>>({});
	let startingContainer = $state<Record<string, boolean>>({});
	let stoppingContainer = $state<Record<string, boolean>>({});

	$effect(() => {
		loadChannels();
	});

	async function loadChannels() {
		loading = true;
		const [channelsRes, healthRes] = await Promise.all([
			apiGet<{ channels: ChannelInfo[] }>('/admin/channels'),
			apiGet<{ services: Record<string, HealthResult> }>('/admin/setup/health-check', { noAuth: true })
		]);
		if (channelsRes.ok && channelsRes.data?.channels) {
			channels = channelsRes.data.channels;
			// Initialize edited configs from current values
			for (const ch of channels) {
				if (!editedConfigs[ch.service]) {
					editedConfigs[ch.service] = { ...ch.config };
				}
				if (restartAfterSave[ch.service] === undefined) {
					restartAfterSave[ch.service] = false;
				}
			}
		} else {
			showToast('Failed to load channels', 'error');
		}
		if (healthRes.ok && healthRes.data?.services) {
			channelHealth = healthRes.data.services;
		}
		loading = false;
	}

	function shortName(service: string): string {
		return service.replace('channel-', '');
	}

	async function toggleAccess(channel: ChannelInfo) {
		const svc = shortName(channel.service);
		const newAccess = channel.access === 'lan' ? 'public' : 'lan';
		togglingAccess[svc] = true;
		const res = await apiPost('/admin/channels/access', {
			channel: svc,
			access: newAccess
		});
		if (res.ok) {
			channel.access = newAccess;
			channels = channels; // trigger reactivity
			showToast(
				`${channel.label} set to ${newAccess === 'lan' ? 'Private' : 'Public'}`,
				'success'
			);
		} else {
			showToast('Failed to update access', 'error');
		}
		togglingAccess[svc] = false;
	}

	async function saveConfig(channel: ChannelInfo) {
		savingConfig[channel.service] = true;
		const config = editedConfigs[channel.service] ?? {};
		const restart = restartAfterSave[channel.service] ?? false;

		// Validate required fields
		for (const field of channel.fields) {
			if (field.required && !config[field.key]?.trim()) {
				showToast(`${field.label} is required`, 'error');
				savingConfig[channel.service] = false;
				return;
			}
		}

		const res = await apiPost('/admin/channels/config', {
			service: channel.service,
			config,
			restart
		});
		if (res.ok) {
			// Update local config
			channel.config = { ...config };
			channels = channels;
			showToast(
				`${channel.label} config saved${restart ? ' and restarting' : ''}`,
				'success'
			);
		} else {
			showToast('Failed to save config', 'error');
		}
		savingConfig[channel.service] = false;
	}

	async function startContainer(channel: ChannelInfo) {
		startingContainer[channel.service] = true;
		const res = await apiPost('/admin/containers/up', {
			service: channel.service
		});
		if (res.ok) {
			showToast(`${channel.label} started`, 'success');
		} else {
			showToast(`Failed to start ${channel.label}`, 'error');
		}
		startingContainer[channel.service] = false;
	}

	async function stopContainer(channel: ChannelInfo) {
		stoppingContainer[channel.service] = true;
		const res = await apiPost('/admin/containers/down', {
			service: channel.service
		});
		if (res.ok) {
			showToast(`${channel.label} stopped`, 'success');
		} else {
			showToast(`Failed to stop ${channel.label}`, 'error');
		}
		stoppingContainer[channel.service] = false;
	}

	function toggleExpanded(service: string) {
		expandedCards[service] = !expandedCards[service];
	}

	function configFieldId(service: string, key: string): string {
		return `config-${service}-${key}`;
	}

	const platformGuidance: Record<string, string> = {
		'channel-chat': 'Web Chat works out of the box. Optionally set an inbound token to restrict access.',
		'channel-discord': 'Create a bot at discord.com/developers/applications. Enable the Message Content intent. Copy the Bot Token and Public Key into the fields below.',
		'channel-voice': 'Voice input works via the built-in web interface. No credentials are required.',
		'channel-telegram': 'Message @BotFather on Telegram to create a bot. Copy the Bot Token here. Set a Webhook Secret for added security.'
	};
</script>

<div class="container">
	<header class="page-header">
		<h1>Channel Management</h1>
		<p class="muted">Configure and manage communication channel adapters.</p>
	</header>

	{#if loading}
		<LoadingSpinner message="Loading channels..." />
	{:else if channels.length === 0}
		<div class="empty-state">
			<p>No channels found.</p>
			<p class="muted">Channel adapters will appear here once configured.</p>
		</div>
	{:else}
		<div class="channel-list">
			{#each channels as channel (channel.service)}
				{@const svc = channel.service}
				{@const name = shortName(svc)}
				{@const isExpanded = expandedCards[svc] ?? false}
				{@const hasFields = channel.fields.length > 0}

				<article class="card channel-card" aria-label="{channel.label} channel">
					<!-- Header -->
					<div class="channel-header">
						<div class="channel-info">
							<div class="channel-name-row">
								<h2 class="channel-name">{channel.label}</h2>
								<HealthBadge ok={channelHealth[svc]?.ok ?? null} />
							</div>
							<span class="channel-service muted">{svc}</span>
						</div>

						<div class="channel-controls">
							<!-- Access toggle -->
							<div class="access-toggle-wrapper">
								<button
									class="access-toggle"
									class:public={channel.access === 'public'}
									onclick={() => toggleAccess(channel)}
									disabled={togglingAccess[name] ?? false}
									aria-label="Toggle {channel.label} access between Private and Public, currently {channel.access === 'lan' ? 'Private' : 'Public'}"
								>
									<span class="access-dot" aria-hidden="true"></span>
									<span class="access-label">
										{channel.access === 'lan' ? 'Private' : 'Public'}
									</span>
								</button>
							</div>
						</div>
					</div>

					<!-- Platform guidance -->
					{#if platformGuidance[svc]}
						<p class="platform-guidance">{platformGuidance[svc]}</p>
					{/if}

					<!-- Config section -->
					{#if hasFields}
						<div class="config-section">
							<button
								class="config-toggle"
								onclick={() => toggleExpanded(svc)}
								aria-expanded={isExpanded}
								aria-controls="config-{svc}"
							>
								<svg
									class="chevron"
									class:expanded={isExpanded}
									width="16"
									height="16"
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									aria-hidden="true"
								>
									<polyline points="6 4 10 8 6 12" />
								</svg>
								<span>Configuration</span>
								<span class="field-count muted">({channel.fields.length} field{channel.fields.length !== 1 ? 's' : ''})</span>
							</button>

							{#if isExpanded}
								<form
									id="config-{svc}"
									class="config-form"
									onsubmit={(e) => { e.preventDefault(); saveConfig(channel); }}
								>
									{#each channel.fields as field (field.key)}
										<div class="form-group">
											<label for={configFieldId(svc, field.key)}>
												{field.label}
												{#if field.required}
													<span class="required" aria-label="required">*</span>
												{/if}
											</label>
											<input
												id={configFieldId(svc, field.key)}
												type={field.type}
												value={editedConfigs[svc]?.[field.key] ?? ''}
												oninput={(e) => {
													if (!editedConfigs[svc]) editedConfigs[svc] = {};
													editedConfigs[svc][field.key] = e.currentTarget.value;
												}}
												placeholder={field.required ? 'Required' : 'Optional'}
												required={field.required}
												autocomplete="off"
											/>
											{#if field.helpText}
												<p class="help-text">{field.helpText}</p>
											{/if}
										</div>
									{/each}

									<div class="config-actions">
										<label class="restart-checkbox">
											<input
												type="checkbox"
												checked={restartAfterSave[svc] ?? false}
												onchange={(e) => {
													restartAfterSave[svc] = e.currentTarget.checked;
												}}
											/>
											<span>Restart after save</span>
										</label>

										<button
											type="submit"
											class="btn-save"
											disabled={savingConfig[svc] ?? false}
										>
											{#if savingConfig[svc]}
												Saving...
											{:else}
												Save Config
											{/if}
										</button>
									</div>
								</form>
							{/if}
						</div>
					{/if}

					<!-- Action buttons -->
					<div class="channel-actions">
						<button
							class="btn-start btn-sm"
							onclick={() => startContainer(channel)}
							disabled={startingContainer[svc] ?? false}
							aria-label="Start {channel.label}"
						>
							{#if startingContainer[svc]}
								Starting...
							{:else}
								Start
							{/if}
						</button>
						<button
							class="btn-stop btn-sm"
							onclick={() => stopContainer(channel)}
							disabled={stoppingContainer[svc] ?? false}
							aria-label="Stop {channel.label}"
						>
							{#if stoppingContainer[svc]}
								Stopping...
							{:else}
								Stop
							{/if}
						</button>
					</div>
				</article>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page-header {
		margin-bottom: 1.5rem;
	}

	.page-header h1 {
		margin: 0 0 0.25rem;
		font-size: 1.5rem;
		font-weight: 700;
	}

	.page-header p {
		margin: 0;
	}

	.channel-list {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.channel-card {
		padding: 0;
		overflow: hidden;
	}

	/* ---- Header ---- */
	.channel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.2rem;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.channel-info {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.channel-name-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.channel-name {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
	}

	.channel-service {
		font-size: 12px;
		font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
	}

	.channel-controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-shrink: 0;
	}

	/* ---- Access Toggle ---- */
	.access-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.35rem 0.85rem;
		border-radius: 999px;
		background: var(--surface2);
		border: 1px solid var(--border);
		color: var(--text);
		font-size: 13px;
		font-weight: 500;
		transition: border-color 0.2s, background 0.2s;
		cursor: pointer;
	}

	.access-toggle:hover:not(:disabled) {
		border-color: var(--accent);
	}

	.access-toggle:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.access-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--green);
		flex-shrink: 0;
	}

	.access-toggle.public .access-dot {
		background: var(--yellow);
	}

	.access-label {
		white-space: nowrap;
	}

	/* ---- Platform Guidance ---- */
	.platform-guidance {
		margin: 0;
		padding: 0.6rem 1.2rem;
		font-size: 13px;
		color: var(--muted);
		line-height: 1.5;
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--accent) 5%, transparent);
	}

	/* ---- Config Section ---- */
	.config-section {
		border-top: 1px solid var(--border);
	}

	.config-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.75rem 1.2rem;
		background: transparent;
		color: var(--text);
		font-size: 14px;
		font-weight: 500;
		border-radius: 0;
		text-align: left;
		transition: background 0.15s;
	}

	.config-toggle:hover {
		background: var(--surface2);
		opacity: 1;
	}

	.chevron {
		transition: transform 0.2s ease;
		flex-shrink: 0;
		color: var(--muted);
	}

	.chevron.expanded {
		transform: rotate(90deg);
	}

	.field-count {
		font-weight: 400;
		font-size: 12px;
	}

	.config-form {
		padding: 0.5rem 1.2rem 1.2rem;
	}

	.config-form .form-group {
		margin-bottom: 0.85rem;
	}

	.config-form label {
		display: block;
		font-size: 13px;
		font-weight: 600;
		margin-bottom: 0.25rem;
		color: var(--text);
	}

	.required {
		color: var(--red);
		margin-left: 0.15rem;
	}

	.config-form input[type='text'],
	.config-form input[type='password'] {
		width: 100%;
	}

	.config-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 1rem;
		flex-wrap: wrap;
	}

	.restart-checkbox {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 13px;
		color: var(--muted);
		cursor: pointer;
		font-weight: 400 !important;
	}

	.restart-checkbox input[type='checkbox'] {
		width: auto;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.btn-save {
		background: var(--accent);
		color: #fff;
		padding: 0.45rem 1.1rem;
		font-size: 13px;
		font-weight: 600;
	}

	/* ---- Action Buttons ---- */
	.channel-actions {
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem 1.2rem;
		border-top: 1px solid var(--border);
		background: rgba(0, 0, 0, 0.1);
	}

	.btn-start {
		background: var(--green);
		color: #fff;
		font-weight: 600;
	}

	.btn-stop {
		background: var(--red);
		color: #fff;
		font-weight: 600;
	}

	/* ---- Responsive ---- */
	@media (max-width: 480px) {
		.channel-header {
			padding: 0.85rem 1rem;
		}

		.config-form {
			padding: 0.5rem 1rem 1rem;
		}

		.channel-actions {
			padding: 0.6rem 1rem;
		}

		.config-actions {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
