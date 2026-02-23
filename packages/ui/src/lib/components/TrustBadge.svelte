<script lang="ts">
	import type { SnippetTrust } from '@openpalm/lib/shared/snippet-types';

	interface Props {
		trust: SnippetTrust;
	}

	let { trust }: Props = $props();

	const config = {
		official: { label: 'Official', cls: 'trust-official', title: 'Shipped with OpenPalm' },
		curated: {
			label: 'Curated',
			cls: 'trust-curated',
			title: 'Reviewed and merged by maintainers'
		},
		community: {
			label: 'Community',
			cls: 'trust-community',
			title: 'Discovered from a community repository'
		}
	};
</script>

<span class="trust-badge {config[trust].cls}" title={config[trust].title}>
	{config[trust].label}
</span>

<style>
	.trust-badge {
		display: inline-block;
		font-size: 11px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 4px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		vertical-align: middle;
	}
	.trust-official {
		background: #dcfce7;
		color: #166534;
	}
	.trust-curated {
		background: #dbeafe;
		color: #1e40af;
	}
	.trust-community {
		background: #f3f4f6;
		color: #4b5563;
	}
</style>
