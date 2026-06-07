<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import AuthGate from '$lib/components/common/AuthGate.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let loading = $state(false);
  let error = $state('');

  async function handleAuthSuccess(token: string): Promise<boolean> {
    if (loading) return false;
    loading = true;
    error = '';
    try {
      const res = await fetch('/admin/auth/login', {
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
      // Cookie is set; refresh server data so the hook now sees us as admin,
      // then navigate to the originally-requested page.
      await invalidateAll();
      await goto(data.redirectTo);
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
