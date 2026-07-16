<script lang="ts">
	import type { Component } from 'svelte';
	import IconOverview from '@openpalm/ui-kit/components/icons/IconOverview.svelte';
	import IconServer from '@openpalm/ui-kit/components/icons/IconServer.svelte';
	import IconJournal from '@openpalm/ui-kit/components/icons/IconJournal.svelte';
	import IconLink from '@openpalm/ui-kit/components/icons/IconLink.svelte';
	import IconMemory from '@openpalm/ui-kit/components/icons/IconMemory.svelte';
	import IconAgent from '@openpalm/ui-kit/components/icons/IconAgent.svelte';
	import IconSharing from '@openpalm/ui-kit/components/icons/IconSharing.svelte';
	import IconActivity from '@openpalm/ui-kit/components/icons/IconActivity.svelte';
	import IconAddons from '@openpalm/ui-kit/components/icons/IconAddons.svelte';
	import IconAutomations from '@openpalm/ui-kit/components/icons/IconAutomations.svelte';
	import IconLock from '@openpalm/ui-kit/components/icons/IconLock.svelte';
	import IconCloudDownload from '@openpalm/ui-kit/components/icons/IconCloudDownload.svelte';
	import IconHome from '@openpalm/ui-kit/components/icons/IconHome.svelte';

	export type TabId =
		| 'overview'
		| 'addons'
		| 'automations'
		| 'connections'
		| 'secrets'
		| 'akm'
		| 'assistant'
		| 'host-sharing'
		| 'activity'
		| 'containers'
		| 'logs'
		| 'updates'
		| 'recovery';

	type SectionId = 'health' | 'mind' | 'routines' | 'capabilities' | 'knowledge';

	interface SubTab {
		id: TabId;
		label: string;
		icon: Component;
	}

	interface Section {
		id: SectionId;
		label: string;
		tabs: SubTab[];
	}

	interface Props {
		active: TabId;
		onSelect: (tab: TabId) => void;
	}

	let { active, onSelect }: Props = $props();

	// Entity-framed sections (configuring the assistant + its host). Section names
	// carry the metaphor; sub-tab nouns are mostly the entity vocabulary too.
	const SECTIONS: Section[] = [
		{
			id: 'health',
			label: 'Health',
			tabs: [
				{ id: 'overview', label: 'Overview', icon: IconOverview },
				{ id: 'activity', label: 'Activity', icon: IconActivity },
				{ id: 'containers', label: 'Systems', icon: IconServer },
				{ id: 'logs', label: 'Journal', icon: IconJournal },
				{ id: 'updates', label: 'Check-up', icon: IconCloudDownload },
				{ id: 'recovery', label: 'Recovery', icon: IconHome },
			],
		},
		{
			id: 'mind',
			label: 'Mind',
			tabs: [{ id: 'connections', label: 'AI Providers', icon: IconLink }],
		},
		{
			id: 'routines',
			label: 'Routines',
			tabs: [{ id: 'automations', label: 'Automations', icon: IconAutomations }],
		},
		{
			id: 'capabilities',
			label: 'Capabilities',
			tabs: [{ id: 'addons', label: 'Add-ons', icon: IconAddons }],
		},
		{
			id: 'knowledge',
			label: 'Knowledge',
			tabs: [
				{ id: 'akm', label: 'Memory', icon: IconMemory },
				{ id: 'assistant', label: 'Assistant', icon: IconAgent },
				{ id: 'secrets', label: 'Secrets', icon: IconLock },
				{ id: 'host-sharing', label: 'Sharing', icon: IconSharing },
			],
		},
	];

	// Derive the active section from the active subtab.
	let activeSection = $derived(
		SECTIONS.find((s) => s.tabs.some((t) => t.id === active)) ?? SECTIONS[0]
	);

	function handleSectionKeydown(e: KeyboardEvent): void {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		const target = e.currentTarget as HTMLElement;
		const tabs = Array.from(
			target.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
		);
		const index = tabs.indexOf(target);
		if (index === -1) return;
		const next =
			e.key === 'ArrowRight'
				? (index + 1) % tabs.length
				: (index - 1 + tabs.length) % tabs.length;
		tabs[next]?.focus();
	}

	function handleSubtabKeydown(e: KeyboardEvent): void {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		const target = e.currentTarget as HTMLElement;
		const tabs = Array.from(
			target.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
		);
		const index = tabs.indexOf(target);
		if (index === -1) return;
		const next =
			e.key === 'ArrowRight'
				? (index + 1) % tabs.length
				: (index - 1 + tabs.length) % tabs.length;
		tabs[next]?.focus();
	}

	function handleSectionClick(section: Section): void {
		// Navigate to the first subtab of the clicked section.
		onSelect(section.tabs[0].id);
	}
</script>

<!-- Section strip (top level) -->
<nav class="nav-shell" aria-label="Admin sections">
	<div class="section-strip" role="tablist" aria-label="Sections">
		{#each SECTIONS as section (section.id)}
			<button
				class="section-tab"
				role="tab"
				aria-selected={activeSection.id === section.id}
				class:section-tab-active={activeSection.id === section.id}
				onclick={() => handleSectionClick(section)}
				onkeydown={handleSectionKeydown}
			>
				{section.label}
			</button>
		{/each}
	</div>

	<!-- Subtab strip (secondary level). Hidden when the section has a single
	     destination — the section tab itself navigates there. -->
	{#if activeSection.tabs.length > 1}
	<div class="subtab-row">
		<div class="tabs" role="tablist" aria-label="{activeSection.label} tabs">
			{#each activeSection.tabs as tab (tab.id)}
				<button
					class="tab"
					role="tab"
					aria-selected={active === tab.id}
					class:tab-active={active === tab.id}
					onclick={() => onSelect(tab.id)}
					onkeydown={handleSubtabKeydown}
				>
					<tab.icon size={13} />
					{tab.label}
				</button>
			{/each}
		</div>
	</div>
	{/if}
</nav>

<style>
	/* ── Nav shell wraps both strips and provides sticky positioning ── */
	.nav-shell {
		position: sticky;
		top: 52px;
		z-index: 40;
		background: var(--s-paper-deep);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		/* No bottom margin: the full-width bar sits flush under the navbar and the
		   admin <main> supplies the gap before content via its top padding. */
	}

	/* ── Section strip (top level) ── */
	.section-strip {
		display: flex;
		gap: 0;
		/* Indent the full-width strip so the first tab aligns with the page
		   content's left padding instead of jamming against the viewport edge. */
		padding-inline: var(--s-sp-6);
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		background: var(--s-paper);
	}

	.section-strip::-webkit-scrollbar {
		display: none;
	}

	.section-tab {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: var(--s-sp-1) var(--s-sp-4);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		text-transform: uppercase;
		letter-spacing: var(--s-track-label);
		color: var(--s-ink-3);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition:
			color var(--s-t-quick) var(--s-ease),
			background-color var(--s-t-quick) var(--s-ease),
			border-color var(--s-t-quick) var(--s-ease);
		margin-bottom: -1px;
	}

	.section-tab:hover {
		color: var(--s-ink-2);
		background: var(--s-paper-deep);
	}

	.section-tab:focus-visible {
		outline: var(--s-hair) solid var(--s-seal);
		outline-offset: 2px;
	}

	/* Active section: deep background to connect visually with the subtab strip,
	   full ink-2 color + seal underline to mark the active state clearly. */
	.section-tab-active {
		color: var(--s-ink-2);
		background: var(--s-paper-deep);
		border-radius: 2px 2px 0 0;
		border-bottom-color: var(--s-seal);
	}

	/* ── Subtab row wraps the scrollable strip ── */
	.subtab-row {
		position: relative;
	}

	/* ── Subtab strip (secondary level) ── */
	.tabs {
		display: flex;
		gap: var(--s-sp-1);
		/* Align the subtab strip with the section strip + page content. */
		padding-inline: var(--s-sp-6);
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		background: var(--s-paper-deep);
		/* No border-bottom here — the nav-shell bottom border serves as the baseline. */
	}

	.tabs::-webkit-scrollbar {
		display: none;
	}

	.tab {
		display: inline-flex;
		align-items: center;
		gap: var(--s-sp-2);
		/* min-height 44px for touch targets per WCAG 2.5.5 */
		min-height: 44px;
		padding: var(--s-sp-2) var(--s-sp-3);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		text-transform: uppercase;
		letter-spacing: var(--s-track-label);
		color: var(--s-ink-3);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition:
			color var(--s-t-quick) var(--s-ease),
			border-color var(--s-t-quick) var(--s-ease);
		margin-bottom: -1px;
	}

	.tab:hover {
		color: var(--s-ink-2);
	}

	.tab:focus-visible {
		outline: var(--s-hair) solid var(--s-seal);
		outline-offset: 2px;
	}

	/* Active subtab: ink underline + full ink color marks the selection clearly. */
	.tab-active {
		color: var(--s-ink);
		border-bottom-color: var(--s-ink);
	}

	@media (max-width: 768px) {
		.tab {
			padding: var(--s-sp-2);
		}
		.section-tab {
			padding: var(--s-sp-1) var(--s-sp-3);
		}
		.section-strip,
		.tabs {
			padding-inline: var(--s-sp-4);
		}
	}

	@media (max-width: 320px) {
		.tab {
			padding: var(--s-sp-1) var(--s-sp-2);
			font-size: var(--s-type-mark-sm);
		}
		.section-tab {
			padding: var(--s-sp-1) var(--s-sp-2);
			font-size: var(--s-type-mark-sm);
		}
	}
</style>
