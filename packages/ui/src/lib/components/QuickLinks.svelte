<script lang="ts">
	import { browser } from '$app/environment';

	const assistantUrl = `/services/opencode/`;
	const openmemoryUrl = browser
		? `${window.location.protocol}//${window.location.hostname}:3000`
		: 'http://localhost:3000';
</script>

<div class="grid2" style="margin-bottom:1rem">
	<a class="link-card" href={assistantUrl} target="_blank">
		<div class="link-icon">&#9997;</div>
		<div>
			<strong>Open OpenCode</strong>
			<div class="muted" style="font-size:13px">Web-based AI assistant interface</div>
		</div>
	</a>
	<a class="link-card" href={openmemoryUrl} target="_blank">
		<div class="link-icon">&#128065;</div>
		<div>
			<strong>Open Memory Dashboard</strong>
			<div class="muted" style="font-size:13px">View and manage stored memories</div>
		</div>
	</a>
	<a class="link-card" href="https://github.com/itlackey/openpalm/blob/main/docs/maintenance.md#uninstalling" target="_blank" rel="noopener">
		<div class="link-icon">&#128218;</div>
		<div>
			<strong>Uninstall Guide</strong>
			<div class="muted" style="font-size:13px">How to remove OpenPalm from your system</div>
		</div>
	</a>
</div>
