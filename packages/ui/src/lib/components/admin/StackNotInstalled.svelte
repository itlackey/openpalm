<script lang="ts">
  /**
   * The host console with nothing to administer.
   *
   * `/host` manages a stack running on THIS computer. When none is installed
   * there is genuinely nothing to show, and the surface used to handle that by
   * redirecting into the setup wizard — which made the wizard unskippable, and
   * only fired on full document loads anyway (the in-app admin button is a
   * client-side navigation, so it sailed past the guard and rendered a live
   * console polling a stack that does not exist).
   *
   * Saying so plainly, with one link into the wizard, lets someone who is only
   * using a remote assistant look at the host console and leave again.
   */
  import EmptyState from '$lib/components/common/EmptyState.svelte';
  import IconServer from '$lib/components/icons/IconServer.svelte';

  interface Props {
    /** Where the setup wizard lives in this process. */
    setupHref: string;
  }

  let { setupHref }: Props = $props();
</script>

<EmptyState>
  {#snippet icon()}<IconServer size={40} />{/snippet}
  <h2>OpenPalm is not installed on this computer</h2>
  <p class="hint">
    This screen manages a copy of OpenPalm running here, and there is not one yet. If you are
    chatting with an assistant on another computer, that keeps working — it is not affected by
    anything on this screen.
  </p>
  {#snippet action()}
    <a class="btn btn-primary" href={setupHref}>Set up OpenPalm on this computer</a>
  {/snippet}
</EmptyState>

<style>
  h2 {
    margin: 0;
    color: var(--s-ink);
    font-family: var(--s-font-header);
    font-size: 1.25rem;
  }

  .hint {
    max-width: 46ch;
    line-height: 1.55;
  }
</style>
