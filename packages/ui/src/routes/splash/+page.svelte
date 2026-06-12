<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>OpenPalm Launch</title>
</svelte:head>

<div class="splash-page">
  <h1>OpenPalm</h1>
  <p>Local status: <strong>{data.launchStatus.local.state}</strong></p>

  {#if data.launchStatus.local.runtime}
    <p>
      Runtime:
      {data.launchStatus.local.runtime.runtimeName ?? 'Docker'}
      {data.launchStatus.local.runtime.dockerPresent ? 'available' : 'missing'}
    </p>
  {/if}

  {#if data.launchStatus.remotes.length > 0}
    <ul>
      {#each data.launchStatus.remotes as remote}
        <li>{remote.name}: {remote.state}</li>
      {/each}
    </ul>
  {/if}

  <div class="actions">
    <a href="/setup">Open setup</a>
    <a href="/chat">Open chat</a>
  </div>
</div>

<style>
  .splash-page {
    max-width: 40rem;
    margin: 4rem auto;
    padding: 1.5rem;
  }

  .actions {
    display: flex;
    gap: 1rem;
    margin-top: 1rem;
  }
</style>
