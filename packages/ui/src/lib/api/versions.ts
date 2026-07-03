import { request, requireOk, requireJsonBody } from './core.js';

// ── Update lifecycle ─────────────────────────────────────────────────────────

export type ApplyChangesResult = {
  ok: boolean;
  restarted: string[];
  failed: { service: string; reason: string }[];
  dockerAvailable: boolean;
  overallSuccess: boolean;
  error?: string;
};

export async function applyChanges(versions: Record<string, string> = {}): Promise<ApplyChangesResult> {
  // The route returns 502 when individual services fail (e.g. an addon
  // image isn't available). The body still carries the structured result,
  // so parse it before requireOk would throw.
  // `versions` carries the target each component should advance to (the resolved
  // channel-latest or a pin) so the update actually moves forward (see UpdatesTab).
  const res = await request('POST', '/admin/update', { versions });
  return requireJsonBody<ApplyChangesResult>(res, `Apply failed (HTTP ${res.status})`);
}

/** Scoped single-service update (§4, §7 "Update <container>"):
 *  pull + recreate ONLY the named compose service. Pull failure is FATAL (§6). */
export async function applyServiceUpdate(service: string, versions: Record<string, string> = {}): Promise<ApplyChangesResult> {
  const res = await request('POST', '/admin/update', { service, versions });
  return requireJsonBody<ApplyChangesResult>(res, `Update failed (HTTP ${res.status})`);
}

// ── Version management ───────────────────────────────────────────────────────

/** Phase-5 per-component version info (three distinct values per component, §5). */
export interface ComponentVersionInfo {
  /** Running: what the live container was created from. Null when not running. */
  running: {
    digest: string;
    tag: string;
    /** Plain version with hardware variant suffix stripped (voice images). */
    plainVersion: string;
    healthStatus: string;
    containerState: string;
  } | null;
  /** Explicit pin from state file, or null = track latest. */
  pinned: string | null;
  /** Best-effort latest on the active channel (null when registry unreachable). */
  available: string | null;
}

/** GET /admin/versions response (Phase 5 shape + backward-compat legacy fields). */
export interface VersionsResponse {
  /** Phase-5 per-component detail (three distinct values per key, §5). */
  components: Record<string, ComponentVersionInfo>;
  /** Channel preference: "latest" (stable releases) or "next" (prereleases). */
  channel: 'latest' | 'next';
  platformVersion: string;
  // Legacy backward-compat fields — old UIs still read these
  versions: Record<string, string>;
  autoUpdate: boolean;
}

export async function fetchVersions(): Promise<VersionsResponse> {
  const res = await requireOk(await request('GET', '/admin/versions'));
  return (await res.json()) as VersionsResponse;
}

/** Persist version pins to stack.env. Only SERVICE_VERSION_KEYS + OP_AUTO_UPDATE
 *  are accepted; the change takes effect on the next POST /admin/update. */
export async function patchVersions(versions: Record<string, string>): Promise<{ ok: boolean; versions: Record<string, string> }> {
  const res = await requireOk(await request('PATCH', '/admin/versions', { versions }));
  return (await res.json()) as { ok: boolean; versions: Record<string, string> };
}

/** Response from GET /admin/versions/latest — resolved latest versions from
 *  GitHub releases (images) and npm registry (packages). null means the registry
 *  was unreachable for that key. */
export interface LatestVersionsResponse {
  versions: Record<string, string | null>;
  errors: string[];
  fetchedAt: string;
}

/** Query the latest available versions from GitHub releases + npm registry.
 *  Called only on explicit user action; never auto-polled. */
export async function fetchLatestVersions(): Promise<LatestVersionsResponse> {
  const res = await requireOk(await request('GET', '/admin/versions/latest'));
  return (await res.json()) as LatestVersionsResponse;
}

export async function downloadUiVersion(
  tag: string,
): Promise<{ ok: boolean; tag: string; restarting: boolean; pendingRestart: boolean }> {
  const res = await requireOk(await request('POST', '/admin/ui-version', { tag }));
  return (await res.json()) as { ok: boolean; tag: string; restarting: boolean; pendingRestart: boolean };
}
