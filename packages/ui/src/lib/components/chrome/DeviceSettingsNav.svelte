<script lang="ts">
	type Props = {
		chatReturnHref: string;
	};

	let { chatReturnHref }: Props = $props();
</script>

<nav class="device-settings-nav" aria-label="Settings sections">
	<div class="nav-inner">
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- validated session-aware conversation path -->
		<a class="nav-target back-link" href={chatReturnHref}>&larr; Return to conversation</a>
		<ul class="peer-tabs">
			<li>
				<a class="nav-target peer-link" href="#connections">Connections</a>
			</li>
			<li>
				<a class="nav-target peer-link" href="#voice">Voice</a>
			</li>
			<li>
				<a class="nav-target peer-link" href="#appearance">Appearance</a>
			</li>
		</ul>
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
		list-style: none;
	}

	.peer-tabs li {
		display: flex;
	}

	.peer-link {
		padding: 0 var(--s-sp-3);
		border-bottom: 2px solid transparent;
		white-space: nowrap;
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
			grid-template-columns: repeat(3, minmax(0, 1fr));
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
