/**
 * Translate raw docker / compose stderr into operator-actionable copy.
 *
 * Lives in $lib/server so the route can import it without violating
 * SvelteKit's +server.ts export rules (handlers + `_`-prefixed only).
 *
 * Pattern matches are intentionally case-insensitive and tolerant of
 * compose-CLI prefix decoration. Order matters: more specific patterns
 * first.
 */
export function translateDockerError(stderr: string | undefined | null): string {
  const raw = (stderr ?? '').trim();
  if (!raw) return 'Docker reported an unknown error (no stderr).';

  // Docker binary missing (ENOENT bubbled up as an error message).
  if (/spawn .*docker.*ENOENT|no such file or directory.*docker|docker:\s*command not found/i.test(raw)) {
    return "Docker isn't installed on this host. Install Docker Engine or Docker Desktop, then retry.";
  }

  // Pull failures: image missing or auth denied.
  if (/pull access denied|manifest unknown|repository does not exist|not found: manifest unknown/i.test(raw)) {
    return "The voice image for this profile isn't published yet. Try the CPU profile.";
  }

  // Registry unreachable (firewall, DNS, mirror misconfig).
  if (/failed to resolve reference|dial tcp.*lookup .+docker\.io|i\/o timeout.*registry|connection refused.*registry/i.test(raw)) {
    return "Can't reach Docker Hub. Check your internet connection, corporate firewall, or configure a registry mirror.";
  }

  // Disk full mid-pull.
  if (/no space left on device|insufficient.*disk space|ENOSPC|write.*disk full/i.test(raw)) {
    return 'Out of disk space. Free space and try again, or run `docker image prune -a` to reclaim unused images.';
  }

  // Port collisions.
  if (/port is already allocated|bind.*address already in use|address already in use|failed to bind host port/i.test(raw)) {
    return 'Port 8880 is already in use on this host. Free it or change the host port (set OP_VOICE_PORT_HOST).';
  }

  // NVIDIA runtime missing (legacy --runtime path).
  if (/unknown[^\n]*runtime[^\n]*nvidia|runtime\s+"nvidia"\s+not\s+found|nvidia.*runtime.*not[^a-z]+(found|registered)/i.test(raw)) {
    return "The NVIDIA Docker runtime isn't registered on this machine. Try the CPU profile, or install nvidia-container-toolkit.";
  }

  // CDI-mode daemon with no spec generated.
  if (/invoking the NVIDIA Container Runtime Hook/i.test(raw)) {
    return 'Docker is in CDI mode but no CDI spec is registered. Try the CPU profile.';
  }

  // Default: include the first ~300 chars verbatim so the operator at
  // least has something searchable.
  const slice = raw.length > 300 ? `${raw.slice(0, 297)}…` : raw;
  return slice;
}
