import type { TabId } from '$lib/components/chrome/TabBar.svelte';

const TAB_IDS = new Set<string>([
  'overview',
  'addons',
  'automations',
  'connections',
  'secrets',
  'akm',
  'assistant',
  'host-sharing',
  'activity',
  'containers',
  'logs',
  'updates',
  'recovery',
]);

function isTabId(value: string | null): value is TabId {
  return value !== null && TAB_IDS.has(value);
}

export function hostTabFromUrl(url: URL): TabId {
  const tab = url.searchParams.get('tab');
  if (tab === 'diagnostics') return 'containers';
  return isTabId(tab) ? tab : 'overview';
}

export function hostUrlForTab(url: URL, tab: TabId): URL {
  const next = new URL(url);
  next.searchParams.set('tab', tab);
  return next;
}

export function hostReturnTo(url: URL): string | undefined {
  const requested = url.searchParams.get('returnTo');
  if (!requested) return undefined;

  try {
    const target = new URL(requested, url);
    if (target.origin !== url.origin) return undefined;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}
