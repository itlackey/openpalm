# TODO: Cache and authenticate the GitHub releases API call

**Status:** Open  
**Symptom:** GitHub API rate limit (5 000 req/hr) exhausted in normal use.

## Root cause

`packages/ui/src/routes/admin/versions/releases/+server.ts` fetches
`https://api.github.com/repos/itlackey/openpalm/releases?per_page=20`
on **every admin page load** with no server-side cache and no auth token.

`onMount` in `packages/ui/src/routes/admin/+page.svelte` (line ~545) calls
`loadReleases()` unconditionally, which hits this endpoint every time any user
opens the admin panel. With multiple users or a browser that re-mounts the
page on navigation, the quota drains quickly.

The Electron update-checker (`packages/electron/src/update-check.ts`) has a
6-hour in-process cache and is a secondary contributor only on frequent app
restarts — not the main driver.

## What to fix

### 1. Add a server-side in-memory cache (required)

Releases don't change more than a few times a day. A 5-minute TTL eliminates
the per-page-load hammering entirely.

```ts
// packages/ui/src/routes/admin/versions/releases/+server.ts

let cachedReleases: { data: ReleaseEntry[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const GET: RequestHandler = async (event) => {
  // ... auth check ...

  const now = Date.now();
  if (cachedReleases && now - cachedReleases.fetchedAt < CACHE_TTL_MS) {
    return json({ releases: cachedReleases.data });
  }

  // ... existing fetch logic ...

  cachedReleases = { data: releases, fetchedAt: now };
  return json({ releases });
};
```

### 2. Pass a GitHub token if available (required)

Without a token, each server IP is limited to 60 unauthenticated requests/hr.
With a token it's 5 000/hr. The env var `GH_TOKEN` (or `KRANG_GH_TOKEN` as a
project-specific alias) should be forwarded to the fetch headers:

```ts
const token = process.env.GH_TOKEN ?? process.env.KRANG_GH_TOKEN;

const res = await fetch(url, {
  headers: {
    "User-Agent": "openpalm-admin/1.0",
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  signal: AbortSignal.timeout(8_000),
});
```

`GH_TOKEN` is already present in the dev environment. In production it can be
set in `knowledge/env/stack.env` (non-secret) or injected via Compose.

### 3. Respect `X-RateLimit-Remaining` (nice-to-have)

When the response header `X-RateLimit-Remaining` is `0`, serve the stale cache
rather than returning an empty result, so the UI degrades gracefully instead of
showing blank version pickers.

## Files to touch

| File | Change |
|---|---|
| `packages/ui/src/routes/admin/versions/releases/+server.ts` | Add cache + auth header |
| `packages/ui/src/routes/admin/versions/ui-versions/+server.ts` | Same pattern — also calls npm registry; check if it needs a cache too |
| `docs/technical/` | Remove this file once done |

## Testing

1. `npm run check` — 0 errors
2. Open the admin panel, watch network tab: second load should NOT fire a GitHub
   request within the 5-minute window
3. With `GH_TOKEN` unset, confirm the fetch still works (unauthenticated fallback)
4. With `GH_TOKEN` set, confirm the `Authorization` header appears in the request
