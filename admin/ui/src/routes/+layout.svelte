<script lang="ts">
	import type { Snippet } from 'svelte';
	import '../app.css';
	import Nav from '$lib/components/Nav.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { apiGet } from '$lib/api';
	import { authToken, setToken } from '$lib/stores/auth';
	import { showToast } from '$lib/stores/toast';
	import type { SetupState } from '$lib/types';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { get } from 'svelte/store';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	let setupChecked = $state(false);
	let setupComplete = $state(true);
	let needsLogin = $state(false);

	let loginPassword = $state('');
	let loginLoading = $state(false);

	$effect(() => {
		checkSetup();
	});

	async function checkSetup() {
		const res = await apiGet<SetupState & { firstBoot?: boolean }>('/admin/setup/status', { noAuth: true });
		if (res.ok && res.data) {
			const data = res.data;
			setupComplete = data.completed ?? false;
			if (!setupComplete && !page.url.pathname.endsWith('/setup')) {
				goto(`${base}/setup`);
			} else if (setupComplete && !get(authToken) && !page.url.pathname.endsWith('/setup')) {
				needsLogin = true;
			}
		}
		setupChecked = true;
	}

	async function handleLogin() {
		if (!loginPassword.trim()) return;
		loginLoading = true;
		setToken(loginPassword.trim());
		const res = await apiGet('/admin/installed');
		if (res.ok) {
			needsLogin = false;
			showToast('Logged in successfully', 'success');
		} else {
			setToken('');
			showToast('Invalid admin token', 'error');
		}
		loginLoading = false;
	}

	let showNav = $derived(setupComplete && !needsLogin && !page.url.pathname.endsWith('/setup'));
</script>

{#if setupChecked}
	{#if needsLogin}
		<main id="main-content">
			<div class="container login-container">
				<div class="login-card">
					<h1>OpenPalm Admin</h1>
					<p class="muted">Enter your admin password to continue.</p>
					<form onsubmit={(e) => { e.preventDefault(); handleLogin(); }}>
						<div class="form-group">
							<label for="login-password">Admin Password</label>
							<input
								id="login-password"
								type="password"
								bind:value={loginPassword}
								placeholder="Enter admin password"
								autocomplete="current-password"
								disabled={loginLoading}
							/>
						</div>
						<button type="submit" disabled={loginLoading || !loginPassword.trim()}>
							{#if loginLoading}Verifying...{:else}Log In{/if}
						</button>
					</form>
				</div>
			</div>
		</main>
		<Toast />
	{:else}
		{#if showNav}
			<Nav />
		{/if}
		<main id="main-content">
			{@render children()}
		</main>
		<Toast />
	{/if}
{/if}

<style>
	.login-container {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 80vh;
	}
	.login-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 2rem;
		max-width: 380px;
		width: 100%;
	}
	.login-card h1 {
		margin: 0 0 0.5rem;
		font-size: 1.5rem;
	}
	.login-card p {
		margin: 0 0 1.5rem;
	}
	.login-card button {
		width: 100%;
		margin-top: 0.75rem;
	}
</style>
