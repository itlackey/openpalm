<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { authToken } from '$lib/stores/auth';

	const links = [
		{ href: '/extensions', label: 'Extensions' },
		{ href: '/channels', label: 'Channels' },
		{ href: '/automations', label: 'Automations' },
		{ href: '/providers', label: 'Providers' },
		{ href: '/config', label: 'Config' },
		{ href: '/containers', label: 'Containers' },
		{ href: '/system', label: 'System' }
	];

	function isActive(href: string): boolean {
		const path = page.url.pathname;
		const full = base + href;
		if (href === '/') return path === base || path === base + '/';
		return path.startsWith(full);
	}
</script>

<nav>
	<a href="{base}/" class="logo" aria-label="OpenPalm home">
		<img src="{base}/logo.png" alt="" width="24" height="24" />
		<span>OpenPalm</span>
	</a>
	{#each links as link}
		<a
			href="{base}{link.href}"
			class="nav-link"
			class:active={isActive(link.href)}
			aria-current={isActive(link.href) ? 'page' : undefined}
		>
			{link.label}
		</a>
	{/each}
</nav>

<style>
	nav {
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		padding: 0.7rem 1rem;
		display: flex;
		align-items: center;
		gap: 1rem;
		position: sticky;
		top: 0;
		z-index: 10;
	}
	.logo {
		font-weight: 700;
		font-size: 18px;
		color: var(--accent2);
		margin-right: auto;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		text-decoration: none;
	}
	.logo img { border-radius: 6px; }
	.nav-link {
		background: transparent;
		color: var(--muted);
		padding: 0.3rem 0.8rem;
		border: 1px solid transparent;
		border-radius: var(--radius);
		font-size: 14px;
		text-decoration: none;
		transition: color 0.15s, border-color 0.15s, background 0.15s;
	}
	.nav-link:hover { color: var(--text); }
	.nav-link.active {
		color: var(--text);
		border-color: var(--accent);
		background: var(--surface2);
	}

	@media (max-width: 480px) {
		nav { flex-wrap: wrap; }
		.logo { width: 100%; margin-bottom: 0.3rem; }
		.nav-link { flex: 1; font-size: 12px; padding: 0.3rem 0.4rem; text-align: center; }
	}
</style>
