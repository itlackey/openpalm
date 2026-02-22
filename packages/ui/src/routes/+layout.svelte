<script lang="ts">
	import { base } from '$app/paths';
	import '../app.css';
	import ToastContainer from '$lib/components/ToastContainer.svelte';

	let { children } = $props();
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
		<button class="active">Dashboard</button>
	</a>
</nav>

<div class="container">
	{@render children()}
</div>

<ToastContainer />
