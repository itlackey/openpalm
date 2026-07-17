<script lang="ts">
	import { resolve } from '$app/paths';
	import { buildReturnToPath } from '$lib/chat/navigation.js';

	type DeviceSettingsPage = 'connections' | 'voice';

	type Props = {
		active: DeviceSettingsPage;
		chatReturnHref: string;
	};

	let { active, chatReturnHref }: Props = $props();
</script>

<nav class="device-settings-nav" aria-label="Device settings">
	<div class="nav-inner">
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- validated session-aware conversation path -->
		<a class="nav-target back-link" href={chatReturnHref}>&larr; Back to conversation</a>
		<!-- eslint-disable svelte/no-navigation-without-resolve -- peer destinations are resolved before the validated return path is appended -->
		<ul class="peer-tabs" aria-label="Device settings pages">
			<li>
				<a
					class="nav-target peer-link"
					class:active={active === 'connections'}
					href={buildReturnToPath(resolve('/connections'), chatReturnHref)}
					aria-current={active === 'connections' ? 'page' : undefined}>Assistant connections</a
				>
			</li>
			<li>
				<a
					class="nav-target peer-link"
					class:active={active === 'voice'}
					href={buildReturnToPath(resolve('/settings/voice'), chatReturnHref)}
					aria-current={active === 'voice' ? 'page' : undefined}>Voice on this device</a
				>
			</li>
		</ul>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
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

	.peer-link.active {
		color: var(--s-ink);
		border-bottom-color: var(--s-ink);
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
			width: 100%;
			margin-left: 0;
			overflow-x: auto;
		}

		.peer-link {
			padding: 0 var(--s-sp-2);
		}
	}
</style>
