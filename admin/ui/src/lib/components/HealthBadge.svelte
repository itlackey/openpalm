<script lang="ts">
	interface Props {
		ok: boolean | null;
		label?: string;
	}

	let { ok, label }: Props = $props();
</script>

<span class="health-badge" class:ok={ok === true} class:err={ok === false} class:unknown={ok === null}>
	<span class="dot" aria-hidden="true"></span>
	{#if label}<span class="label">{label}</span>{/if}
</span>

<style>
	.health-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 13px;
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		display: inline-block;
	}
	.ok .dot { background: var(--green); }
	.err .dot { background: var(--red); }
	.unknown .dot { background: var(--muted); }
	.label { color: var(--muted); }
</style>
