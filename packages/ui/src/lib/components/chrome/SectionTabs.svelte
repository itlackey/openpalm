<script lang="ts">
	import type { Component } from 'svelte';

	export type SectionTab = {
		id: string;
		label: string;
		icon?: Component;
	};

	export type TabSection = {
		id: string;
		label: string;
		tabs: SectionTab[];
	};

	type Props = {
		active: string;
		sections: TabSection[];
		onSelect: (tab: string) => void;
		ariaLabel: string;
		mobileLabel: string;
		tabIdPrefix?: string;
		panelIdPrefix?: string;
		showSectionStrip?: boolean;
	};

	let {
		active,
		sections,
		onSelect,
		ariaLabel,
		mobileLabel,
		tabIdPrefix,
		panelIdPrefix,
		showSectionStrip = true,
	}: Props = $props();

	const activeSection = $derived(
		sections.find((section) => section.tabs.some((tab) => tab.id === active)) ?? sections[0]
	);

	function tabId(id: string): string | undefined {
		return tabIdPrefix ? `${tabIdPrefix}-${id}` : undefined;
	}

	function panelId(id: string): string | undefined {
		return panelIdPrefix ? `${panelIdPrefix}-${id}` : undefined;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		const tabs = Array.from(
			target.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
		);
		const index = tabs.indexOf(target);
		if (index === -1) return;
		const next = event.key === 'Home'
			? 0
			: event.key === 'End'
				? tabs.length - 1
				: event.key === 'ArrowRight'
					? (index + 1) % tabs.length
					: (index - 1 + tabs.length) % tabs.length;
		tabs[next]?.focus();
	}

	function handleMobileSelect(event: Event): void {
		onSelect((event.currentTarget as HTMLSelectElement).value);
	}
</script>

<nav class="nav-shell" aria-label={ariaLabel}>
	<label class="mobile-navigation">
		<span>{mobileLabel}</span>
		<select value={active} onchange={handleMobileSelect}>
			{#each sections as section (section.id)}
				<optgroup label={section.label}>
					{#each section.tabs as tab (tab.id)}
						<option value={tab.id}>{tab.label}</option>
					{/each}
				</optgroup>
			{/each}
		</select>
	</label>

	{#if showSectionStrip}
		<div class="section-strip" role="tablist" aria-label="Sections">
			{#each sections as section (section.id)}
				{@const destination = section.tabs[0]}
				<button
					id={section.tabs.length === 1 ? tabId(destination.id) : undefined}
					class="section-tab"
					class:section-tab-active={activeSection.id === section.id}
					role="tab"
					aria-selected={activeSection.id === section.id}
					aria-controls={section.tabs.length === 1 ? panelId(destination.id) : undefined}
					tabindex={activeSection.id === section.id ? 0 : -1}
					onclick={() => onSelect(destination.id)}
					onkeydown={handleKeydown}
				>
					{section.label}
				</button>
			{/each}
		</div>
	{/if}

	{#if activeSection.tabs.length > 1}
		<div class="subtab-row">
			<div class="tabs" role="tablist" aria-label="{activeSection.label} tabs">
				{#each activeSection.tabs as tab (tab.id)}
					<button
						id={tabId(tab.id)}
						class="tab"
						class:tab-active={active === tab.id}
						role="tab"
						aria-selected={active === tab.id}
						aria-controls={panelId(tab.id)}
						tabindex={active === tab.id ? 0 : -1}
						onclick={() => onSelect(tab.id)}
						onkeydown={handleKeydown}
					>
						{#if tab.icon}<tab.icon size={13} />{/if}
						{tab.label}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</nav>

<style>
	.nav-shell {
		position: sticky;
		top: var(--nav-height);
		z-index: 40;
		background: var(--s-paper-deep);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
	}

	.mobile-navigation {
		display: none;
	}

	.section-strip,
	.tabs {
		display: flex;
		max-width: 100%;
		overflow-x: auto;
		overflow-y: hidden;
		padding-inline: var(--s-sp-6);
	}

	.section-strip {
		gap: 0;
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		background: var(--s-paper);
	}

	.section-tab,
	.tab {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		border: 0;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		background: none;
		color: var(--s-ink-3);
		font-family: var(--s-font-mono);
		text-transform: uppercase;
		letter-spacing: var(--s-track-label);
		white-space: nowrap;
		cursor: pointer;
		flex-shrink: 0;
	}

	.section-tab {
		padding: var(--s-sp-1) var(--s-sp-4);
		font-size: var(--s-type-mark);
		transition:
			color var(--s-t-quick) var(--s-ease),
			background-color var(--s-t-quick) var(--s-ease),
			border-color var(--s-t-quick) var(--s-ease);
	}

	.section-tab:hover,
	.section-tab-active {
		color: var(--s-ink-2);
		background: var(--s-paper-deep);
	}

	.section-tab-active {
		border-radius: 2px 2px 0 0;
		border-bottom-color: var(--s-seal);
	}

	.subtab-row {
		position: relative;
	}

	.tabs {
		gap: var(--s-sp-1);
		background: var(--s-paper-deep);
	}

	.tab {
		gap: var(--s-sp-2);
		padding: var(--s-sp-2) var(--s-sp-3);
		font-size: var(--s-type-mark-sm);
		transition:
			color var(--s-t-quick) var(--s-ease),
			border-color var(--s-t-quick) var(--s-ease);
	}

	.tab:hover {
		color: var(--s-ink-2);
	}

	.tab-active {
		color: var(--s-ink);
		border-bottom-color: var(--s-ink);
	}

	.section-tab:focus-visible,
	.tab:focus-visible,
	.mobile-navigation select:focus-visible {
		outline: var(--s-hair) solid var(--s-seal);
		outline-offset: 2px;
	}

	@media (max-width: 768px) {
		.section-tab {
			padding: var(--s-sp-1) var(--s-sp-3);
		}
		.tab {
			padding: var(--s-sp-2);
		}
		.section-strip,
		.tabs {
			padding-inline: var(--s-sp-4);
		}
	}

	@media (max-width: 640px) {
		.mobile-navigation {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: center;
			gap: var(--s-sp-3);
			padding: var(--s-sp-2) var(--s-sp-4);
			background: var(--s-paper);
			color: var(--s-ink-3);
			font-family: var(--s-font-mono);
			font-size: var(--s-type-mark-sm);
			text-transform: uppercase;
			letter-spacing: var(--s-track-label);
		}

		.mobile-navigation select {
			min-width: 0;
			width: 100%;
			min-height: 44px;
			padding: var(--s-sp-2) var(--s-sp-3);
			border: var(--s-hair) solid var(--s-line);
			border-radius: 2px;
			background: var(--s-paper-deep);
			color: var(--s-ink);
			font-family: var(--s-font-mono);
			font-size: var(--s-type-mark-sm);
			cursor: pointer;
		}

		.section-strip,
		.subtab-row {
			display: none;
		}
	}
</style>
