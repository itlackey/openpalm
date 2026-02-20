<script lang="ts">
	import { apiGetText, apiPost } from '$lib/api';
	import { showToast } from '$lib/stores/toast';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';

	type SaveResponse = {
		ok: boolean;
		backup?: string;
		error?: string;
	};

	let loading = $state(true);
	let saving = $state(false);
	let configText = $state('');
	let originalText = $state('');
	let restartAfterSave = $state(false);
	let errorMessage = $state('');

	let isDirty = $derived(configText !== originalText);

	$effect(() => {
		loadConfig();
	});

	async function loadConfig() {
		loading = true;
		errorMessage = '';
		const res = await apiGetText('/admin/config');
		if (res.ok) {
			configText = res.data;
			originalText = res.data;
		} else {
			errorMessage = 'Failed to load configuration. Check that the server is running.';
			showToast('Failed to load config', 'error');
		}
		loading = false;
	}

	async function reloadConfig() {
		if (isDirty) {
			const confirmed = window.confirm(
				'You have unsaved changes. Reloading will discard them. Continue?'
			);
			if (!confirmed) return;
		}
		await loadConfig();
		showToast('Configuration reloaded', 'success');
	}

	async function saveConfig() {
		saving = true;
		errorMessage = '';

		const res = await apiPost<SaveResponse>('/admin/config', {
			config: configText,
			restart: restartAfterSave
		});

		if (res.ok && res.data?.ok !== false) {
			originalText = configText;
			const backupNote = res.data?.backup ? ` Backup: ${res.data.backup}` : '';
			const restartNote = restartAfterSave ? ' OpenCode Core restart requested.' : '';
			showToast(`Configuration saved.${backupNote}${restartNote}`, 'success');
		} else {
			const errData = res.data as SaveResponse & { error?: string; details?: string };
			const msg = errData?.error || errData?.details || 'Failed to save configuration.';
			errorMessage = msg;
			showToast('Save failed: ' + msg, 'error');
		}

		saving = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') {
			e.preventDefault();
			if (!saving && isDirty) {
				saveConfig();
			}
		}
	}
</script>

<svelte:head>
	<title>Config Editor - OpenPalm Admin</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="container">
	<header class="page-header">
		<div>
			<h1>Config Editor</h1>
			<p class="muted">View and edit the <code>opencode.jsonc</code> agent configuration file.</p>
		</div>
	</header>

	{#if loading}
		<LoadingSpinner message="Loading configuration..." />
	{:else}
		<!-- Toolbar -->
		<div class="toolbar" role="toolbar" aria-label="Configuration editor toolbar">
			<div class="toolbar-left">
				<button
					class="btn-secondary btn-sm"
					onclick={reloadConfig}
					disabled={saving}
					aria-label="Reload configuration from server"
				>
					Reload
				</button>

				<button
					onclick={saveConfig}
					disabled={saving || !isDirty}
					aria-label="Save configuration"
				>
					{#if saving}
						Saving...
					{:else}
						Save
					{/if}
				</button>

				{#if isDirty}
					<span class="dirty-badge" role="status">Unsaved changes</span>
				{/if}
			</div>

			<label class="restart-option">
				<input
					type="checkbox"
					bind:checked={restartAfterSave}
					aria-describedby="restart-desc"
				/>
				<span>Restart OpenCode Core after saving</span>
			</label>
		</div>

		<!-- Error display -->
		{#if errorMessage}
			<div class="error-banner" role="alert">
				<strong>Error:</strong> {errorMessage}
				<button
					class="dismiss-btn"
					onclick={() => (errorMessage = '')}
					aria-label="Dismiss error"
				>
					&times;
				</button>
			</div>
		{/if}

		<!-- Editor -->
		<div class="editor-wrap">
			<label for="config-editor" class="sr-only">Configuration editor</label>
			<textarea
				id="config-editor"
				class="config-editor"
				bind:value={configText}
				rows={24}
				spellcheck={false}
				autocomplete="off"
				autocorrect="off"
				autocapitalize="off"
				aria-label="JSONC configuration editor"
			></textarea>
		</div>

		<!-- Info card -->
		<div class="card info-card" aria-labelledby="policy-heading">
			<h3 id="policy-heading">Policy Lint Rules</h3>
			<p>
				The server enforces a security policy on permission values in the configuration.
				Only the following permission values are accepted:
			</p>
			<ul class="policy-list">
				<li>
					<code class="allowed">"ask"</code> &mdash; The agent will prompt for
					confirmation before executing the action.
				</li>
				<li>
					<code class="allowed">"deny"</code> &mdash; The action is blocked entirely;
					the agent cannot perform it.
				</li>
				<li>
					<code class="blocked">"allow"</code> &mdash;
					<strong>Blocked.</strong> Granting unrestricted permission is not permitted.
					The server will reject any configuration that sets a permission to "allow".
				</li>
			</ul>
			<p class="muted hint-text">
				If your save is rejected, check that no permission field is set to
				<code>"allow"</code>. Change it to <code>"ask"</code> or <code>"deny"</code> and
				try again. Parse errors in the JSONC will also be reported.
			</p>
			<p class="muted hint-text" id="restart-desc">
				Enabling "Restart OpenCode Core after saving" will signal the core process to
				reload with the updated configuration. This may briefly interrupt active sessions.
			</p>
		</div>

		<!-- Keyboard shortcut hint -->
		<p class="muted shortcut-hint">
			Tip: Press <kbd>Ctrl</kbd>+<kbd>S</kbd> (or <kbd>Cmd</kbd>+<kbd>S</kbd>) to save.
		</p>
	{/if}
</div>

<style>
	.page-header {
		margin-bottom: 1.5rem;
	}
	.page-header h1 {
		margin: 0 0 0.25rem;
		font-size: 1.6rem;
	}
	.page-header p {
		margin: 0;
	}
	.page-header code {
		background: var(--surface2);
		padding: 0.1em 0.4em;
		border-radius: 4px;
		font-size: 0.9em;
	}

	/* Toolbar */
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
		flex-wrap: wrap;
	}
	.toolbar-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.dirty-badge {
		font-size: 12px;
		color: var(--yellow, #eab308);
		font-weight: 500;
		padding: 0.15rem 0.5rem;
		border: 1px solid color-mix(in srgb, var(--yellow, #eab308) 40%, transparent);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--yellow, #eab308) 8%, transparent);
	}

	.restart-option {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 13px;
		color: var(--muted);
		cursor: pointer;
		user-select: none;
	}
	.restart-option input[type='checkbox'] {
		width: auto;
		margin: 0;
		accent-color: var(--accent);
		cursor: pointer;
	}

	/* Error banner */
	.error-banner {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		margin-bottom: 0.75rem;
		background: color-mix(in srgb, var(--red) 10%, var(--surface));
		border: 1px solid color-mix(in srgb, var(--red) 40%, var(--border));
		border-radius: var(--radius);
		color: var(--red);
		font-size: 14px;
		line-height: 1.5;
		word-break: break-word;
	}
	.error-banner strong {
		flex-shrink: 0;
	}
	.dismiss-btn {
		margin-left: auto;
		flex-shrink: 0;
		background: transparent;
		color: var(--red);
		padding: 0;
		font-size: 18px;
		line-height: 1;
		opacity: 0.7;
		border: none;
		cursor: pointer;
	}
	.dismiss-btn:hover {
		opacity: 1;
	}

	/* Editor textarea */
	.editor-wrap {
		margin-bottom: 1rem;
	}
	.config-editor {
		width: 100%;
		min-height: 480px;
		font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'Consolas',
			'Monaco', monospace;
		font-size: 13px;
		line-height: 1.6;
		tab-size: 2;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		resize: vertical;
		white-space: pre;
		overflow-wrap: normal;
		overflow-x: auto;
	}
	.config-editor:focus {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	/* Info card */
	.info-card {
		border-color: color-mix(in srgb, var(--accent) 25%, var(--border));
	}
	.info-card h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.info-card p {
		margin: 0 0 0.6rem;
		font-size: 14px;
		line-height: 1.6;
	}

	.policy-list {
		list-style: none;
		padding: 0;
		margin: 0 0 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.policy-list li {
		font-size: 14px;
		line-height: 1.5;
		padding: 0.5rem 0.75rem;
		background: var(--surface2);
		border-radius: calc(var(--radius) / 2);
	}

	.policy-list code {
		font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
		padding: 0.1em 0.35em;
		border-radius: 3px;
		font-size: 13px;
		font-weight: 600;
	}
	code.allowed {
		background: color-mix(in srgb, var(--green) 15%, var(--surface));
		color: var(--green);
	}
	code.blocked {
		background: color-mix(in srgb, var(--red) 15%, var(--surface));
		color: var(--red);
	}

	.hint-text {
		font-size: 13px;
		margin: 0 0 0.4rem;
	}
	.hint-text:last-child {
		margin-bottom: 0;
	}
	.hint-text code {
		background: var(--surface2);
		padding: 0.1em 0.3em;
		border-radius: 3px;
		font-size: 12px;
	}

	/* Keyboard shortcut hint */
	.shortcut-hint {
		font-size: 12px;
		margin-top: 0.5rem;
	}
	kbd {
		display: inline-block;
		padding: 0.1em 0.4em;
		font-family: 'SF Mono', 'Consolas', monospace;
		font-size: 11px;
		background: var(--surface2);
		border: 1px solid var(--border);
		border-radius: 3px;
		box-shadow: 0 1px 0 var(--border);
	}

	/* Responsive */
	@media (max-width: 600px) {
		.toolbar {
			flex-direction: column;
			align-items: flex-start;
		}
		.config-editor {
			font-size: 12px;
			min-height: 320px;
		}
	}
</style>
