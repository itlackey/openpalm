<script lang="ts">
  /**
   * CloudAttachPanel — the simplest possible "connect your AI" step.
   *
   * Two states only, no jargon:
   *   - An AI account was found on this computer → one "Use this account" button.
   *   - Otherwise (or "use a different account") → sign-in buttons.
   *
   * Deliberately NO provider count/list, NO "other options", and NO custom
   * endpoint / API-key fields — those are power-user concerns that live in the
   * admin dashboard after setup, not in first-run.
   */

  import ProviderOAuthList from './ProviderOAuthList.svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { setupState } from '$lib/setup/setup-state.svelte.js';

  // Takes NO props: reads the setup-state store directly (hostImporting /
  // verifiedCount) and calls its host-import method, mirroring Screen1ModelsStep
  // / ReviewStep. The nested ProviderOAuthList likewise reads the store.
  const s = setupState;

  // The wizard always drove these as 0 / [] — the "account already found on this
  // computer" path is inert in the current flow but kept for behavior parity.
  const credentialCount = 0;
  const cloudProviders: string[] = [];

  const hostImporting = $derived(s.hostImporting);
  const verifiedCount = $derived(s.verifiedCount);
  const onhostimport = (): void => void s.handleHostImport();

  const hasFoundAccount = $derived(credentialCount > 0 || cloudProviders.length > 0);
  const connected = $derived(verifiedCount > 0);

  // When an account is found, default to using it; let the user switch to sign-in.
  let signInInstead = $state(false);
  const showSignIn = $derived(!hasFoundAccount || signInInstead);
</script>

<div class="cloud-attach">
  {#if !showSignIn}
    <!-- An AI account was detected on this computer -->
    {#if connected}
      <p class="connected" role="status">
        <span class="check" aria-hidden="true">✓</span>
        Connected your AI account.
      </p>
      <button type="button" class="account-link" onclick={() => (signInInstead = true)}>
        Use a different account
      </button>
    {:else if hostImporting}
      <p class="connecting" role="status"><Spinner /> Connecting your AI account…</p>
    {:else}
      <p class="lead">We found an AI account on this computer.</p>
      <button type="button" class="btn-connect" id="btn-host-import" onclick={onhostimport}>
        Use this account
      </button>
      <button type="button" class="account-link" onclick={() => (signInInstead = true)}>
        Use a different account
      </button>
    {/if}
  {:else}
    <!-- Sign in to a cloud AI service -->
    <p class="lead">Sign in to your AI service:</p>
    <ProviderOAuthList />
    {#if hasFoundAccount}
      <button type="button" class="account-link" onclick={() => (signInInstead = false)}>
        Use the account on this computer instead
      </button>
    {/if}
  {/if}
</div>

<style>
  .cloud-attach {
    margin-top: 12px;
    padding: 16px;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper-deep);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .lead {
    margin: 0;
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }

  .connected {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--s-type-deed);
    font-weight: 400;
    color: var(--s-moss);
  }

  .check {
    font-weight: 400;
  }

  .connecting {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
  }

  .btn-connect {
    padding: 10px 20px;
    background: var(--s-seal);
    border: none;
    border-radius: 2px;
    font-size: var(--s-type-deed);
    font-weight: 400;
    /* Dark text on amber/orange clears WCAG AA/AAA (white on orange fails). */
    color: #1a0e00;
    cursor: pointer;
    min-height: 44px;
  }

  .btn-connect:hover {
    background: var(--s-seal);
  }

  .account-link {
    background: none;
    border: none;
    padding: 4px 0;
    min-height: 24px;
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .account-link:hover {
    color: var(--s-ink-2);
  }
</style>
