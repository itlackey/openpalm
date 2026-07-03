/** Canonical GitHub repository slug for OpenPalm release assets. */
export const GITHUB_REPO = 'itlackey/openpalm';

/**
 * Extract the release tag from a GitHub `releases/latest` redirect target.
 *
 * Release tags are bare semver since the 0.12.41 v-prefix retirement (e.g.
 * `/tag/0.12.43`); the optional `v?` still matches a legacy v-tagged release
 * so `latest` keeps resolving across both conventions.
 */
export function parseReleaseTagFromLocation(location: string | null | undefined): string | null {
  const match = (location ?? '').match(/\/tag\/(v?[0-9]+\.[0-9]+\.[0-9]+[^\s]*)$/);
  return match?.[1] ?? null;
}

/**
 * Resolve the latest published release tag by following (without redirecting)
 * the `releases/latest` URL and parsing the `Location` header. Returns `null`
 * on any network/timeout error or an unparseable target so callers can decide
 * their own fallback (install falls back to the CLI version; self-update
 * treats it as a hard failure).
 */
export async function resolveLatestReleaseTag(timeoutMs = 10_000): Promise<string | null> {
  try {
    const res = await fetch(`https://github.com/${GITHUB_REPO}/releases/latest`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return parseReleaseTagFromLocation(res.headers.get('location'));
  } catch {
    return null;
  }
}
