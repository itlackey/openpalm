<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$lib/api";

  type ServiceHealth = {
    name: string;
    status: string;
    health?: string | null;
  };

  let unhealthy: ServiceHealth[] = $state([]);
  let dismissed = $state(false);

  onMount(async () => {
    const r = await api("/stack/drift");
    if (!r.ok) return;
    const services: ServiceHealth[] = r.data.services ?? [];
    unhealthy = services.filter((s) => s.status !== "running" || (s.health && s.health !== "healthy"));
  });

  async function reconcile() {
    await api("/stack/apply", { method: "POST" });
  }
</script>

{#if !dismissed && unhealthy.length > 0}
  <div class="drift-banner">
    <strong>Unhealthy containers:</strong>
    {unhealthy.map((s) => s.name).join(", ")}
    <button onclick={reconcile}>Reconcile</button>
    <button onclick={() => (dismissed = true)}>Dismiss</button>
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
