/**
 * Host-fact probes for the voice addon bring-up engine, plus the
 * OP_VOICE_LAN_ACCESS opt-in reader below.
 *
 * Split out of packages/ui/.../voice/bring-up.ts (2.2 — "collapse to one
 * compose driver, including voice"): these inspect the *host* docker daemon
 * (rootless mode, registered runtimes) rather than UI/addon/compose state, so
 * they belong in lib beside hardware-detect.ts, not the UI-only bring-up
 * orchestration. bring-up.ts consumes them to decide whether to include the
 * static voice.compose.rootless.yml / voice.compose.cdi.yml overlays.
 *
 * isVoiceLanAccessEnabled isn't a host-fact probe — it reads OPERATOR intent
 * from stack.env, not the docker daemon. It lives here anyway rather than in
 * addons.ts or compose-args.ts (the more obviously named homes for an addon
 * env flag): both of those already import config-persistence.ts, and
 * config-persistence.ts's discoverStackOverlays needs to call this function,
 * so putting it in either would create an import cycle. This file's own
 * imports (addon-availability.ts, docker.ts) don't reach back to
 * config-persistence.ts, so it stays a safe one-way edge.
 */
import { execFileNoThrow } from "./addon-availability.js";
import { dockerBin } from "./docker.js";
import { readStackEnv } from "./secrets.js";

/**
 * Detect rootless Docker. The compose `user: "${OP_UID:-1000}:${OP_GID:-1000}"`
 * directive bakes the host UID into the container — but on a rootless daemon
 * the bind-mount UID inside the container is subuid-remapped, so the
 * resulting container UID has no write permission against
 * `${OP_HOME}/data/voice/models`. Removing the `user:` directive (via the
 * voice.compose.rootless.yml overlay) lets Docker pick whatever UID the
 * rootless mapping translates to inside the user namespace, which DOES have
 * write access to the bind-mount.
 *
 * `docker info` is the authoritative source: rootless daemons advertise
 * `SecurityOptions: ... name=rootless` and `CgroupDriver: ... rootless`.
 * We accept either signal.
 */
export async function detectRootlessDocker(): Promise<boolean> {
  const res = await execFileNoThrow(
    dockerBin(),
    ['info', '--format', '{{json .}}'],
    5_000,
  );
  if (!res.ok || !res.stdout) return false;
  try {
    const parsed = JSON.parse(res.stdout) as {
      SecurityOptions?: unknown;
      CgroupDriver?: unknown;
    };
    const sec = Array.isArray(parsed.SecurityOptions)
      ? parsed.SecurityOptions.map((s) => String(s))
      : [];
    if (sec.some((s) => /name=rootless/i.test(s))) return true;
    if (typeof parsed.CgroupDriver === 'string' && /rootless/i.test(parsed.CgroupDriver)) {
      return true;
    }
    return false;
  } catch {
    // Fall back to a stringy contains-check if the JSON shape changes.
    return /name=rootless|cgroup\s*driver:.*rootless/i.test(res.stdout);
  }
}

/**
 * Lightweight wrapper around `docker info` to check whether the `nvidia`
 * runtime is registered. Used as a second signal alongside the cached
 * canonical CUDA profile availability result (getAddonProfileAvailability),
 * which also accepts a CDI-only host as available.
 */
export async function dockerHasNvidiaRuntime(): Promise<boolean> {
  const res = await execFileNoThrow(
    dockerBin(),
    ['info', '--format', '{{json .Runtimes}}'],
    2_000,
  );
  return res.ok && res.stdout.includes('"nvidia"');
}

// ── Voice LAN-access opt-in ──────────────────────────────────────────

/**
 * Voice-container LAN reachability opt-in: `OP_VOICE_LAN_ACCESS` in
 * `state/stack.env`, default OFF. Same truthy set as the other opt-in flags
 * in bind-warning.ts (`isTrustedProxyEnabled` / `isRemoteSetupAllowed`):
 * `1` | `true` | `yes`, case-insensitive, trimmed.
 *
 * Off (default): voice stays segmented onto `addon_net` only
 * (services.compose.yml) — the addon trust boundary's default posture (a
 * compromised addon image has no path to the assistant's OpenCode API,
 * S.6b / D3(b)).
 *
 * On: the operator has opted this FIRST-PARTY addon into the SAME
 * per-service exception the boundary already grants ollama (a third-party
 * image) — reachability over `assistant_net` — because the container-served
 * UI otherwise has no network path to a sibling addon container and cannot
 * proxy `/voice` for LAN browsers. See voice.compose.lan.yml
 * (packages/skeleton/system/stack/) for the full reasoning.
 *
 * Consumed by discoverStackOverlays (config-persistence.ts) to decide
 * whether to include that overlay in EVERY compose invocation — not only
 * the voice bring-up engine's one-off applyStack call — and mirrored into
 * the assistant entrypoint via `OP_VOICE_LAN_ACCESS` (core.compose.yml
 * interpolation) to decide whether the served UI advertises/proxies voice.
 */
export function isVoiceLanAccessEnabled(homeDir: string): boolean {
  const raw = readStackEnv(homeDir).OP_VOICE_LAN_ACCESS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
