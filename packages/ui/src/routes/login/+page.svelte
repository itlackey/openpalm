<script lang="ts">
  import { goto } from '$app/navigation';
  import AuthGate from '@openpalm/ui-kit/components/common/AuthGate.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let loading = $state(false);
  let error = $state('');

  async function handleAuthSuccess(token: string): Promise<boolean> {
    if (loading) return false;
    // Capture the destination before any await so it can't be clobbered by a
    // data refresh mid-flight.
    const target = data.redirectTo || '/chat';
    loading = true;
    error = '';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: token }),
        credentials: 'include'
      });
      if (!res.ok) {
        error = res.status === 503
          ? 'Admin password is not configured yet. Complete setup first.'
          : 'Invalid password.';
        return false;
      }
      // Cookie is set; navigate to the originally-requested page. goto runs the
      // destination's loads fresh with the new cookie, so the hook admits us.
      // (No invalidateAll: re-running this page's load would fire its own
      // already-authed redirect and race this goto.)
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- redirectTo is a server-validated internal path, not a static route id
      await goto(target);
      return true;
    } catch {
      error = 'Unable to reach admin API.';
      return false;
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Sign in — OpenPalm</title>
</svelte:head>

<AuthGate onSuccess={handleAuthSuccess} {loading} {error} />
