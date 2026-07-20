<script lang="ts">
	type Props = {
		chatReturnHref: string;
		activeTab: 'general' | 'connections';
		onTabChange: (tab: 'general' | 'connections') => void;
	};

	let { chatReturnHref, activeTab, onTabChange }: Props = $props();
	let generalTab: HTMLButtonElement;
	let connectionsTab: HTMLButtonElement;

	function handleTabKeydown(event: KeyboardEvent, tab: 'general' | 'connections'): void {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const next = event.key === 'Home'
			? 'general'
			: event.key === 'End'
				? 'connections'
				: tab === 'general'
					? 'connections'
					: 'general';
		onTabChange(next);
		requestAnimationFrame(() => (next === 'general' ? generalTab : connectionsTab).focus());
	}
</script>

<nav class="device-settings-nav" aria-label="Settings sections">
	<div class="nav-inner">
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- validated session-aware conversation path -->
		<a class="nav-target back-link" href={chatReturnHref}>&larr; Return to conversation</a>
		<div class="peer-tabs" role="tablist" aria-label="Settings tabs">
			<button
				bind:this={generalTab}
				id="settings-tab-general"
				type="button"
				class="nav-target peer-link"
				role="tab"
				aria-selected={activeTab === 'general'}
				aria-controls="settings-panel-general"
				tabindex={activeTab === 'general' ? 0 : -1}
				onclick={() => onTabChange('general')}
				onkeydown={(event) => handleTabKeydown(event, 'general')}
			>General</button>
			<button
				bind:this={connectionsTab}
				id="settings-tab-connections"
				type="button"
				class="nav-target peer-link"
				role="tab"
				aria-selected={activeTab === 'connections'}
				aria-controls="settings-panel-connections"
				tabindex={activeTab === 'connections' ? 0 : -1}
				onclick={() => onTabChange('connections')}
				onkeydown={(event) => handleTabKeydown(event, 'connections')}
			>Connections</button>
		</div>
	</div>
</nav>

<style>
	.device-settings-nav {
		position: sticky;
		top: 52px;
		z-index: 40;
		background: var(--s-paper-deep);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
	}

	.nav-inner {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: var(--s-sp-4);
		width: 100%;
		max-width: 760px;
		min-width: 0;
		margin: 0 auto;
		padding: 0 var(--s-sp-6);
	}

	.nav-target {
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		min-width: 44px;
		min-height: 44px;
		color: var(--s-ink-3);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-deed);
		text-decoration: none;
	}

	.nav-target:hover {
		color: var(--s-ink);
	}

	.nav-target:focus-visible {
		outline: 2px solid var(--s-ink);
		outline-offset: 2px;
	}

	.back-link {
		flex-shrink: 0;
	}

	.peer-tabs {
		display: flex;
		align-self: stretch;
		gap: var(--s-sp-1);
		min-width: 0;
		margin: 0 0 0 auto;
		padding: 0;
	}

	.peer-link {
		padding: 0 var(--s-sp-3);
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		cursor: pointer;
		white-space: nowrap;
	}

	.peer-link[aria-selected='true'] {
		border-bottom-color: var(--s-seal);
		color: var(--s-ink);
	}

	@media (max-width: 640px) {
		.nav-inner {
			flex-wrap: wrap;
			gap: 0;
			padding: 0 var(--s-sp-3);
		}

		.back-link {
			width: 100%;
		}

		.peer-tabs {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			width: 100%;
			margin-left: 0;
			overflow: visible;
		}

		.peer-link {
			justify-content: center;
			min-height: 56px;
			padding: 0 var(--s-sp-2);
			line-height: 1.3;
			text-align: center;
			white-space: normal;
		}
	}
</style>
