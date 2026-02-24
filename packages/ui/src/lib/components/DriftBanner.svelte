<script lang="ts">
  import { onMount } from "svelte";

  type DriftReport = {
    missingServices: string[];
    exitedServices: string[];
    missingEnvFiles: string[];
    staleArtifacts: boolean;
  };

  let drift: DriftReport | null = null;
  let dismissed = false;

  onMount(async () => {
    const response = await fetch("/stack/drift");
    if (!response.ok) return;
    const payload = await response.json();
    drift = payload.drift ?? null;
  });

  function hasDrift(report: DriftReport | null): boolean {
    if (!report) return false;
    return report.missingServices.length > 0 || report.exitedServices.length > 0 || report.missingEnvFiles.length > 0 || report.staleArtifacts;
  }

  async function reconcile() {
    await fetch("/stack/apply", { method: "POST" });
  }
</script>

{#if !dismissed && hasDrift(drift)}
  <div class="drift-banner">
    <strong>Compose drift detected.</strong>
    <button on:click={reconcile}>Reconcile</button>
    <button on:click={() => (dismissed = true)}>Dismiss</button>
  </div>
{/if}

<style>
  .drift-banner {
    padding: 12px;
    background: #f6efe4;
    border: 1px solid #d9c7a5;
    border-radius: 8px;
    display: flex;
    gap: 12px;
    align-items: center;
  }
</style>
