// Notify-only update check. Polls GitHub releases for the newest tag,
// compares to the current Electron app version, and exposes the result
// to the UI via environment variables that the SvelteKit server reads.

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  latestUrl: string | null;
  updateAvailable: boolean;
  /** Set when the check failed; UI treats as "no update available". */
  error?: string;
  /** Epoch ms when this result was produced. Used by the 6h cache. */
  fetchedAt: number;
}

const REPO_OWNER = "itlackey";
const REPO_NAME = "openpalm";
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cached: UpdateInfo | null = null;

/** Strip a leading "v" and split into numeric segments. */
function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(/[.\-+]/).map((s) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** Returns true if `latest` is strictly greater than `current` (semver-ish). */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (bi > ai) return true;
    if (bi < ai) return false;
  }
  return false;
}

export async function checkForElectronUpdate(currentVersion: string): Promise<UpdateInfo> {
  // Reuse cached result for 6h.
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      cached = {
        currentVersion,
        latestVersion: null,
        latestUrl: null,
        updateAvailable: false,
        error: `HTTP ${res.status}`,
        fetchedAt: Date.now(),
      };
      return cached;
    }
    const data = await res.json() as { tag_name?: string; html_url?: string };
    const tag = data.tag_name ?? "";
    const latestVersion = tag.replace(/^v/, "");
    const updateAvailable = latestVersion ? isNewerVersion(currentVersion, latestVersion) : false;
    cached = {
      currentVersion,
      latestVersion: latestVersion || null,
      latestUrl: data.html_url ?? null,
      updateAvailable,
      fetchedAt: Date.now(),
    };
    return cached;
  } catch (err) {
    cached = {
      currentVersion,
      latestVersion: null,
      latestUrl: null,
      updateAvailable: false,
      error: err instanceof Error ? err.message : String(err),
      fetchedAt: Date.now(),
    };
    return cached;
  }
}

/** Last known update info. Used to inject env vars into the UI server. */
export function getCachedUpdateInfo(): UpdateInfo | null {
  return cached;
}
