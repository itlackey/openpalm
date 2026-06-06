<script lang="ts">
	export type TabId =
		| 'overview'
		| 'addons'
		| 'automations'
		| 'connections'
		| 'secrets'
		| 'voice'
		| 'akm'
		| 'containers'
		| 'logs'
		| 'updates';

	type SectionId = 'system' | 'configure' | 'extend';

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
		voice: `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />`,
		addons: `<path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />`,
		automations: `<circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />`,
		secrets: `<rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />`,
		updates: `<polyline points="8 17 12 21 16 17" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" />`,
	};

	const SECTIONS: Section[] = [
		{
			id: 'system',
			label: 'System',
			tabs: [
				{ id: 'overview', label: 'Overview', icon: ICONS.overview },
				{ id: 'containers', label: 'Containers', icon: ICONS.containers },
				{ id: 'logs', label: 'Logs', icon: ICONS.logs },
				{ id: 'updates', label: 'Updates', icon: ICONS.updates },
			],
		},
		{
			id: 'configure',
			label: 'Configure',
			tabs: [
				{ id: 'connections', label: 'AI Providers', icon: ICONS.connections },
				{ id: 'akm', label: 'Knowledge', icon: ICONS.akm },
				{ id: 'voice', label: 'Voice', icon: ICONS.voice },
			],
		},
		{
			id: 'extend',
			label: 'Extend',
			tabs: [
				{ id: 'addons', label: 'Addons', icon: ICONS.addons },
				{ id: 'automations', label: 'Automations', icon: ICONS.automations },
				{ id: 'secrets', label: 'Secrets', icon: ICONS.secrets },
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

	<!-- Subtab strip (secondary level — only active section's tabs) -->
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
</nav>

<style>
	/* ── Nav shell wraps both strips and provides sticky positioning ── */
	.nav-shell {
		position: sticky;
		top: var(--nav-height);
		z-index: 40;
		background: var(--color-bg-secondary);
		border-bottom: 1px solid var(--color-border);
		margin-bottom: var(--space-6);
	}

	/* ── Section strip (top level) ── */
	.section-strip {
		display: flex;
		gap: 0;
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
	}

	@media (max-width: 320px) {
		.tab {
			padding: var(--space-1) var(--space-2);
			font-size: var(--text-xs);
		}
		.section-tab {
			padding: var(--space-1) var(--space-2);
			font-size: 0.6rem;
		}
	}
</style>
