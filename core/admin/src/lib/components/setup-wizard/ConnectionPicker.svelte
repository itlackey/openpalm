<script lang="ts">
	interface Props {
		onSelectCloud: () => void;
		onSelectLocal: () => void;
	}

	let { onSelectCloud, onSelectLocal }: Props = $props();
</script>

<!-- Cloud / Remote option -->
<button class="conn-card conn-card--cloud" type="button" onclick={onSelectCloud}>
	<div class="conn-icon conn-icon--cloud" aria-hidden="true">
		<!-- Cloud icon -->
		<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
		</svg>
	</div>

	<div class="conn-body">
		<span class="conn-label">Remote OpenAI-compatible <span class="conn-badge">Remote</span></span>
		<span class="conn-desc">Use this for OpenAI, proxies, gateways, and any service that exposes an OpenAI-style /v1 API.</span>
	</div>

	<div class="conn-arrow" aria-hidden="true">
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="9 18 15 12 9 6" />
		</svg>
	</div>
</button>

<!-- Local option -->
<button class="conn-card conn-card--local" type="button" onclick={onSelectLocal}>
	<div class="conn-icon conn-icon--local" aria-hidden="true">
		<!-- Server/hardware icon -->
		<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="2" width="20" height="8" rx="2" />
			<rect x="2" y="14" width="20" height="8" rx="2" />
			<circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" />
			<circle cx="6" cy="18" r="1" fill="currentColor" stroke="none" />
		</svg>
	</div>

	<div class="conn-body">
		<span class="conn-label">Local OpenAI-compatible <span class="conn-badge conn-badge--local">On-Device</span></span>
		<span class="conn-desc">Use this for LM Studio or any local server that exposes an OpenAI-style /v1 API. e.g., http://localhost:1234/v1</span>
	</div>

	<div class="conn-arrow" aria-hidden="true">
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="9 18 15 12 9 6" />
		</svg>
	</div>
</button>

<style>
	/* ── Card shell ─────────────────────────────────────────────────────── */
	.conn-card {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		width: 100%;
		padding: var(--space-5);
		background: var(--color-bg);
		border: 1.5px solid var(--color-border);
		border-radius: var(--radius-lg);
		cursor: pointer;
		text-align: left;
		margin-bottom: var(--space-3);

		/* Smooth lift on hover */
		transition:
			border-color 180ms ease,
			box-shadow 180ms ease,
			background 180ms ease,
			transform 120ms ease;
		will-change: transform;
	}

	.conn-card:last-child {
		margin-bottom: 0;
	}

	/* Hover: lift + accent border + subtle shadow */
	.conn-card:hover {
		border-color: var(--color-primary);
		background: var(--color-bg);
		box-shadow:
			0 0 0 3px var(--color-primary-subtle),
			0 4px 12px rgba(0, 0, 0, 0.06);
		transform: translateY(-1px);
	}

	/* Active/pressed: snap back slightly to give tactile feedback */
	.conn-card:active {
		transform: translateY(0px);
		box-shadow: 0 0 0 3px var(--color-primary-subtle);
		transition-duration: 60ms;
	}

	/* ── Icon container ──────────────────────────────────────────────────── */
	.conn-icon {
		flex-shrink: 0;
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-md);

		/* Smooth colour transition on card hover */
		transition: background 180ms ease, color 180ms ease;
	}

	/* Cloud icon: blue-tinted background, brand-adjacent */
	.conn-icon--cloud {
		background: rgba(51, 154, 240, 0.1);
		color: #339af0;
	}

	/* Local icon: warm green — evokes "on my machine / offline" */
	.conn-icon--local {
		background: rgba(64, 192, 87, 0.1);
		color: #40c057;
	}

	/* Icon brightens on card hover */
	.conn-card:hover .conn-icon--cloud {
		background: rgba(51, 154, 240, 0.18);
	}

	.conn-card:hover .conn-icon--local {
		background: rgba(64, 192, 87, 0.18);
	}

	/* ── Text body ──────────────────────────────────────────────────────── */
	.conn-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		flex: 1;
		min-width: 0; /* prevent flex blowout */
	}

	.conn-label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-base); /* 14px — one step up from current text-sm */
		font-weight: var(--font-semibold);
		color: var(--color-text);
		line-height: var(--leading-tight);
	}

	.conn-desc {
		font-size: var(--text-sm); /* 13px — up from text-xs */
		color: var(--color-text-secondary);
		line-height: 1.45;
	}

	/* ── Badge ──────────────────────────────────────────────────────────── */
	.conn-badge {
		display: inline-flex;
		align-items: center;
		padding: 1px 7px;
		font-size: 0.6875rem; /* 11px */
		font-weight: var(--font-semibold);
		letter-spacing: 0.03em;
		border-radius: var(--radius-full);

		/* Default (cloud): info-blue */
		background: rgba(51, 154, 240, 0.1);
		color: #1c7ed6;
		border: 1px solid rgba(51, 154, 240, 0.2);
	}

	/* Local badge: green */
	.conn-badge--local {
		background: rgba(64, 192, 87, 0.1);
		color: #2f9e44;
		border-color: rgba(64, 192, 87, 0.2);
	}

	/* ── Chevron arrow ──────────────────────────────────────────────────── */
	.conn-arrow {
		flex-shrink: 0;
		color: var(--color-text-tertiary);
		transition: color 180ms ease, transform 180ms ease;
		display: flex;
		align-items: center;
	}

	/* Arrow slides right on hover and picks up brand colour */
	.conn-card:hover .conn-arrow {
		color: var(--color-primary);
		transform: translateX(2px);
	}
</style>
