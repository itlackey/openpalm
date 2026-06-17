<script lang="ts">
	export type TabId =
		| 'overview'
		| 'addons'
		| 'automations'
		| 'connections'
		| 'secrets'
		| 'voice'
		| 'akm'
		| 'assistant'
		| 'host-sharing'
		| 'activity'
		| 'containers'
		| 'logs'
		| 'updates'
		| 'recovery';

	type SectionId = 'health' | 'mind' | 'voice' | 'routines' | 'capabilities' | 'knowledge';

	interface SubTab {
		id: TabId;
		label: string;
		icon: string; // SVG path data (inner content)
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

	// Icon SVG inner-markup keyed by tab id. Exact SVGs from the original flat strip.
	const ICONS: Record<TabId, string> = {
		overview: `<rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />`,
		containers: `<rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />`,
		logs: `<polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />`,
		connections: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />`,
		akm: `<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />`,
		assistant: `<path d="M12 2a4 4 0 0 1 4 4v2h1a3 3 0 0 1 3 3v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-6a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4z" /><path d="M9 8h6" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /><path d="M9 18c1 .8 2 .8 3 .8s2 0 3-.8" />`,
		'host-sharing': `<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />`,
		activity: `<path d="M3 12h4l2-5 4 10 2-5h6" />`,
		voice: `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />`,
		addons: `<path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />`,
		automations: `<circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />`,
		secrets: `<rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />`,
		updates: `<polyline points="8 17 12 21 16 17" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" />`,
		recovery: `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />`,
	};

	// Entity-framed sections (configuring the assistant + its host). Section names
	// carry the metaphor; sub-tab nouns are mostly the entity vocabulary too.
	const SECTIONS: Section[] = [
		{
			id: 'health',
			label: 'Health',
			tabs: [
				{ id: 'overview', label: 'Overview', icon: ICONS.overview },
				{ id: 'activity', label: 'Activity', icon: ICONS.activity },
				{ id: 'containers', label: 'Systems', icon: ICONS.containers },
				{ id: 'logs', label: 'Journal', icon: ICONS.logs },
				{ id: 'updates', label: 'Check-up', icon: ICONS.updates },
				{ id: 'recovery', label: 'Recovery', icon: ICONS.recovery },
			],
		},
		{
			id: 'mind',
			label: 'Mind',
			tabs: [{ id: 'connections', label: 'AI Providers', icon: ICONS.connections }],
		},
		{
			id: 'voice',
			label: 'Voice',
			tabs: [{ id: 'voice', label: 'Voice', icon: ICONS.voice }],
		},
		{
			id: 'routines',
			label: 'Routines',
			tabs: [{ id: 'automations', label: 'Automations', icon: ICONS.automations }],
		},
		{
			id: 'capabilities',
			label: 'Capabilities',
			tabs: [{ id: 'addons', label: 'Add-ons', icon: ICONS.addons }],
		},
		{
			id: 'knowledge',
			label: 'Knowledge',
			tabs: [
				{ id: 'akm', label: 'Memory', icon: ICONS.akm },
				{ id: 'assistant', label: 'Assistant', icon: ICONS.assistant },
				{ id: 'secrets', label: 'Secrets', icon: ICONS.secrets },
				{ id: 'host-sharing', label: 'Sharing', icon: ICONS['host-sharing'] },
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
					<svg
						aria-hidden="true"
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html tab.icon}
					</svg>
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
		top: var(--nav-height);
		z-index: 40;
		background: var(--color-bg-secondary);
		border-bottom: 1px solid var(--color-border);
		/* No bottom margin: the full-width bar sits flush under the navbar and the
		   admin <main> supplies the gap before content via its top padding. */
	}

	/* ── Section strip (top level) ── */
	.section-strip {
		display: flex;
		gap: 0;
		/* Indent the full-width strip so the first tab aligns with the page
		   content's left padding instead of jamming against the viewport edge. */
		padding-inline: var(--space-6);
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg);
	}

	.section-strip::-webkit-scrollbar {
		display: none;
	}

	.section-tab {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: var(--space-1) var(--space-4);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: var(--font-medium);
		color: var(--color-text-muted, var(--color-text-secondary));
		background: none;
		border: none;
		border-bottom: 3px solid transparent;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition:
			color var(--transition-fast),
			background-color var(--transition-fast),
			border-color var(--transition-fast);
		margin-bottom: -1px;
	}

	.section-tab:hover {
		color: var(--color-text);
		background: var(--color-bg-secondary);
	}

	.section-tab:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}

	/* Active section: distinguished by a filled "connected tab" background + full
	   text color + semibold weight (≥3 properties vs inactive). NO orange — orange
	   stays reserved for primary-action fills. The fill matches the subtab strip
	   below so the active section reads as connected to its subtabs. */
	.section-tab-active {
		color: var(--color-text);
		font-weight: var(--font-semibold);
		background: var(--color-bg-secondary);
		border-top-left-radius: var(--radius-md);
		border-top-right-radius: var(--radius-md);
	}

	/* ── Subtab row wraps the scrollable strip + fade affordance ── */
	.subtab-row {
		position: relative;
	}

	/* Fade affordances — positioned over the scroll container, not inside it
	   (avoids the flex-shrink conflict). Symmetric left+right so a partially
	   scrolled tab label is softened under a gradient instead of showing as a
	   hard mid-word fragment at either edge. */
	.subtab-row::after {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 48px;
		background: linear-gradient(to right, transparent, var(--color-bg-secondary));
		pointer-events: none;
	}

	.subtab-row::before {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		bottom: 0;
		width: 40px;
		background: linear-gradient(to left, transparent, var(--color-bg-secondary));
		pointer-events: none;
		z-index: 1;
	}

	/* ── Subtab strip (secondary level) ── */
	.tabs {
		display: flex;
		gap: var(--space-1);
		/* Align the subtab strip with the section strip + page content. */
		padding-inline: var(--space-6);
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		/* No border-bottom here — the nav-shell bottom border serves as the baseline. */
	}

	.tabs::-webkit-scrollbar {
		display: none;
	}

	.tab {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		/* min-height 44px for touch targets per WCAG 2.5.5 */
		min-height: 44px;
		padding: var(--space-2) var(--space-3);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: var(--font-medium);
		color: var(--color-text-secondary);
		background: none;
		border: none;
		border-bottom: 3px solid transparent;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition:
			color var(--transition-fast),
			border-color var(--transition-fast),
			font-weight var(--transition-fast);
		margin-bottom: -1px;
	}

	.tab:hover {
		color: var(--color-text);
	}

	.tab:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}

	/* Active subtab: differs by ≥2 properties (rubric cat 1 + 7).
	   border-color (neutral underline) + font-weight (semibold) + color (full text). */
	.tab-active {
		color: var(--color-text);
		font-weight: var(--font-semibold);
		border-bottom-color: var(--color-text);
	}

	@media (max-width: 768px) {
		.tab {
			padding: var(--space-2);
		}
		.section-tab {
			padding: var(--space-1) var(--space-3);
		}
		.section-strip,
		.tabs {
			padding-inline: var(--space-4);
		}
	}

	@media (max-width: 320px) {
		.tab {
			padding: var(--space-1) var(--space-2);
			font-size: var(--text-xs);
		}
		.section-tab {
			padding: var(--space-1) var(--space-2);
			/* Never below the 12px legibility floor (WCAG 1.4.4) — was 0.6rem/9.6px. */
			font-size: var(--text-xs);
		}
	}
</style>
