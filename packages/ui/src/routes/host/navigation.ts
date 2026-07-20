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

// Conversation surfaces the /host "back" affordances may return to. Mirrors
// lib/chat/navigation.ts internalConversationPath's allowlist — kept as an
// independent copy (not a shared import) because the admin surface must stay
// free of chat-state imports (#555). Any returnTo outside this set is
// attacker-supplied (legitimate producers only ever emit /chat or /advanced),
// so the brand logo / "Back to chat" links must never honor an arbitrary
// same-origin path (e.g. /login?redirectTo=… or a state-changing GET route).
const RETURN_TO_PATHS = new Set(['/chat', '/advanced']);

export function hostReturnTo(url: URL): string | undefined {
  const requested = url.searchParams.get('returnTo');
  if (!requested) return undefined;

  try {
    // Root-relative or absolute forms are both allowed, but the origin check
    // rejects cross-origin / protocol-relative (//evil) / opaque (javascript:)
    // targets, and the pathname allowlist rejects any same-origin path that
    // isn't a conversation surface (e.g. /login, /api/…) — the "back" links
    // must never navigate the admin to an arbitrary internal route.
    const target = new URL(requested, url);
    if (target.origin !== url.origin) return undefined;
    if (!RETURN_TO_PATHS.has(target.pathname)) return undefined;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}
