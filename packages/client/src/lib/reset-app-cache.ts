/**
 * "Reset app cache" (H3, review 2026-07-10 §H3 — client half): the client
 * has no cache-escape affordance anywhere. A stale/dead build can pin itself
 * indefinitely once precached (see the H2 fix in bin/serve.mjs for how that
 * happens) with no way for the user to recover short of clearing browser
 * site data by hand. This unregisters every service-worker registration,
 * deletes every Cache Storage bucket this origin owns, and reloads — the
 * layout wires a button to it (routes/+layout.svelte).
 *
 * Dependency-injected (mirrors $lib/desktop-notifications.ts's pattern) so
 * it unit-tests without a real browser: every argument defaults to the
 * matching global and is only reached when that global exists, so calling
 * this from a non-browser context (SSR, tests with no DOM) is a safe no-op
 * on the unregister/delete steps.
 *
 * Best-effort throughout: one failed unregister()/delete() must not stop
 * the rest, and the reload always happens — a half-cleared cache is still
 * strictly better than a stuck one, and the user asked for a reset, not a
 * report.
 */

export type ResetAppCacheDeps = {
  serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistrations'>;
  caches?: Pick<CacheStorage, 'keys' | 'delete'>;
  reload?: () => void;
};

function defaultServiceWorker(): Pick<ServiceWorkerContainer, 'getRegistrations'> | undefined {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
}

function defaultCaches(): Pick<CacheStorage, 'keys' | 'delete'> | undefined {
  return typeof caches !== 'undefined' ? caches : undefined;
}

function defaultReload(): void {
  if (typeof window !== 'undefined') window.location.reload();
}

async function settleAll<T>(items: readonly T[], run: (item: T) => Promise<unknown>): Promise<void> {
  await Promise.allSettled(items.map(run));
}

export async function resetAppCache(deps: ResetAppCacheDeps = {}): Promise<void> {
  const serviceWorker = deps.serviceWorker ?? defaultServiceWorker();
  const cachesApi = deps.caches ?? defaultCaches();
  const reload = deps.reload ?? defaultReload;

  if (serviceWorker) {
    try {
      const registrations = await serviceWorker.getRegistrations();
      await settleAll(registrations, (registration) => registration.unregister());
    } catch {
      // Best-effort — fall through to the cache/reload steps regardless.
    }
  }

  if (cachesApi) {
    try {
      const keys = await cachesApi.keys();
      await settleAll(keys, (key) => cachesApi.delete(key));
    } catch {
      // Best-effort — the reload below still gives the user a clean start.
    }
  }

  reload();
}
