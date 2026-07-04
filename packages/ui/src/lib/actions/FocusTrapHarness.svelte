<!-- Test-only harness: a trigger button + a persistent panel whose focus trap
     toggles via an `open` boolean, mirroring how the chat veil / tool drawer use
     the shared focus-trap primitives. Includes disabled + aria-hidden controls
     so the harness also exercises focusable-collection filtering. -->
<script lang="ts">
  import { createFocusTrap, handleTrapKeydown } from './focus-trap.js';

  let open = $state(false);
  function close(): void {
    open = false;
  }
</script>

<button data-testid="trigger" onclick={() => (open = true)}>Open</button>

{#if open}
  <div
    data-testid="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Test panel"
    tabindex="-1"
    onkeydown={(event) => handleTrapKeydown(event, close)}
    {@attach createFocusTrap()}
  >
    <input data-testid="first" type="text" placeholder="first" />
    <button data-testid="middle">Middle</button>
    <button data-testid="last" onclick={close}>Close</button>
  </div>
{/if}
