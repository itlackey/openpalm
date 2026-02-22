<script lang="ts">
	import { getAdminToken } from '$lib/stores/auth.svelte';

	interface Props {
		error: string;
	}

	let { error }: Props = $props();
	const currentToken = $derived(getAdminToken());
</script>

<p>Set your admin password to protect this management interface.</p>

{#if error}
	<div class="wiz-error visible">{error}</div>
{/if}

<div class="sec-box">
	<div class="sec-title">Admin Password</div>
	<div style="font-size:13px;margin-bottom:0.5rem">
		Your admin password was printed in the terminal during installation. Look for the line
		labeled <strong>"YOUR ADMIN PASSWORD"</strong> and paste it below.
	</div>
	<div style="font-size:12px;margin-bottom:0.5rem;color:var(--muted)">
		If you lost it, you can also find it in the <code>.env</code> file (look for
		<code>ADMIN_TOKEN</code>) in the folder where you ran the installer.
	</div>
	<input type="password" id="wiz-admin" value={currentToken} placeholder="Paste your admin password here" />
</div>

<div class="sec-box" style="margin-top:0.7rem">
	<div class="sec-title">Security Features</div>
	<ul style="font-size:13px;margin:0.2rem 0">
		<li>Messages are cryptographically verified</li>
		<li>Sensitive data is automatically filtered from memory</li>
		<li>Rate limiting prevents abuse</li>
		<li>Admin access restricted to your network</li>
	</ul>
</div>
