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
  import type { OpenCodeProvider, AuthMethod, ProviderState } from '$lib/client/types.js';

  interface Props {
    credentialCount?: number;
    cloudProviders?: string[];
    opencodeProviders?: OpenCodeProvider[];
    opencodeAuth?: Record<string, AuthMethod[]>;
    providerState?: Record<string, ProviderState>;
    hostImporting?: boolean;
    verifiedCount?: number;
    onhostimport?: () => void;
    onoauthstart?: (id: string, methodIndex: number) => void;
    onoauthcancel?: (id: string) => void;
    // Accepted for backward compatibility with the parent; intentionally unused
    // (custom endpoint / key entry moved out of the wizard).
    onbaseurl?: (id: string, url: string) => void;
    onapikey?: (id: string, key: string) => void;
    onverify?: (id: string) => void;
  }

  let {
    credentialCount = 0,
    cloudProviders = [],
    opencodeProviders = [],
    opencodeAuth = {},
    providerState = {},
    hostImporting = false,
    verifiedCount = 0,
    onhostimport,
    onoauthstart,
    onoauthcancel,
  }: Props = $props();

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
    <ProviderOAuthList
      {opencodeProviders}
      {opencodeAuth}
      {providerState}
      onoauthstart={(id, idx) => onoauthstart?.(id, idx)}
      onoauthcancel={(id) => onoauthcancel?.(id)}
    />
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
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-bg-secondary);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .lead {
    margin: 0;
    font-size: var(--text-base, 1rem);
    color: var(--color-text);
  }

  .connected {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-base, 1rem);
    font-weight: var(--font-medium, 500);
    color: var(--color-success-text);
  }

  .check {
    font-weight: var(--font-bold, 700);
  }

  .connecting {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-base, 1rem);
    color: var(--color-text-secondary);
  }

  .btn-connect {
    padding: 10px 20px;
    background: var(--color-primary);
    border: none;
    border-radius: var(--radius-lg);
    font-size: var(--text-base, 1rem);
    font-weight: var(--font-semibold, 600);
    /* Dark text on amber/orange clears WCAG AA/AAA (white on orange fails). */
    color: #1a0e00;
    cursor: pointer;
    min-height: 44px;
  }

  .btn-connect:hover {
    background: var(--color-primary-hover);
  }

  .account-link {
    background: none;
    border: none;
    padding: 4px 0;
    min-height: 24px;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-tertiary);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .account-link:hover {
    color: var(--color-text-secondary);
  }
</style>
