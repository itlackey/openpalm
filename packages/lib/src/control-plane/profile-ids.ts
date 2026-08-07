export type HardwareProfileVariant = 'cpu' | 'cuda' | 'rocm';

// Variant suffixes were hardware-only (cpu|cuda|rocm) until the `remote`
// addon's provider variants (addon.remote.tailscale, later
// addon.remote.pangolin-*) widened the grammar to any lowercase label
// (roadmap: remote-access-providers.md §2). Addon identity is still enforced
// where it matters — canonicalAddonProfileSelection rejects a profile whose
// addon segment doesn't match — and hardware-specific consumers go through
// resolveHardwareProfileVariant below, which still admits only the three
// hardware suffixes.
const PROFILE_ID_RE = /^addon\.([a-z0-9-]+)(?:\.([a-z0-9][a-z0-9-]*))?$/;

const HARDWARE_VARIANTS: ReadonlySet<string> = new Set(['cpu', 'cuda', 'rocm']);

export function addonProfileId(addon: string, variant: HardwareProfileVariant): string {
  return `addon.${addon}.${variant}`;
}

export function resolveHardwareProfileVariant(profileId: string): HardwareProfileVariant | null {
  const variant = profileId.match(PROFILE_ID_RE)?.[2];
  if (!variant || !HARDWARE_VARIANTS.has(variant)) return null;
  return variant as HardwareProfileVariant;
}

export function canonicalAddonProfileSelection(addon: string, profile: string): string {
  const trimmed = profile.trim();
  if (!trimmed) return '';

  const match = trimmed.match(PROFILE_ID_RE);
  if (!match || match[1] !== addon) return '';

  return trimmed;
}
