<script lang="ts">
	import type { RiskLevel } from '$lib/types';

	interface Props {
		risk: RiskLevel;
	}

	let { risk }: Props = $props();

	const colors: Record<RiskLevel, string> = {
		lowest: 'var(--green)',
		low: '#30d158',
		medium: 'var(--yellow)',
		'medium-high': 'var(--orange)',
		highest: 'var(--red)'
	};
</script>

<span class="risk-badge" style="background: {colors[risk] ?? 'var(--muted)'}; color: {risk === 'medium' ? '#000' : '#fff'}">
	{risk}
</span>

<style>
	.risk-badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 12px;
		font-size: 12px;
		font-weight: 600;
		text-transform: capitalize;
	}
</style>
