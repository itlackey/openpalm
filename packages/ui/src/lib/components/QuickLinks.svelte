<script lang="ts">
	import { base } from '$app/paths';
	import { browser } from '$app/environment';

	const assistantUrl = `${base}/opencode/`;
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
</div>
