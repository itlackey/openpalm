/**
 * Host-fact probes for the voice addon bring-up engine.
 *
 * Split out of packages/ui/.../voice/bring-up.ts (2.2 — "collapse to one
 * compose driver, including voice"): these inspect the *host* docker daemon
 * (rootless mode, registered runtimes) rather than UI/addon/compose state, so
 * they belong in lib beside hardware-detect.ts, not the UI-only bring-up
 * orchestration. bring-up.ts consumes them to decide whether to include the
 * static voice.compose.rootless.yml / voice.compose.cdi.yml overlays.
 */
import { execFileNoThrow } from "./addon-availability.js";

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
    'docker',
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
    'docker',
    ['info', '--format', '{{json .Runtimes}}'],
    2_000,
  );
  return res.ok && res.stdout.includes('"nvidia"');
}
