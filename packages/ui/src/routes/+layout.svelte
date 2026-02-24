<script lang="ts">
	import { base } from '$app/paths';
	import { browser, version } from '$app/environment';
	import '../app.css';
	import ToastContainer from '$lib/components/ToastContainer.svelte';

	let { children } = $props();
	let theme = $state<'light' | 'dark'>('dark');

	function applyTheme(next: 'light' | 'dark') {
		theme = next;
		if (!browser) return;
		document.documentElement.dataset.theme = next;
		localStorage.setItem('openpalm-theme', next);
	}

	$effect(() => {
		if (!browser) return;
		const saved = localStorage.getItem('openpalm-theme');
		if (saved === 'light' || saved === 'dark') {
			applyTheme(saved);
			return;
		}
		const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
		applyTheme(prefersLight ? 'light' : 'dark');
	});
</script>

<svelte:head>
	<title>OpenPalm Admin</title>
</svelte:head>

<nav>
	<span class="logo">
		<img src="{base}/logo.png" alt="OpenPalm logo" />
		OpenPalm
	</span>
	<a href="{base}/" style="text-decoration:none">
		<button class="nav-btn active">Dashboard</button>
	</a>
	<span class="muted" style="font-size:12px">UI {version}</span>
	<button
		class="theme-toggle"
		onclick={() => applyTheme(theme === 'light' ? 'dark' : 'light')}
		aria-label="Toggle color mode"
	>
		{theme === 'light' ? '🌙 Dark' : '☀️ Light'}
	</button>
</nav>

<div class="container">
	{@render children()}
</div>

<ToastContainer />
