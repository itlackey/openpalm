export type HardwareProfileVariant = 'cpu' | 'cuda' | 'rocm';

const PROFILE_ID_RE = /^addon\.([a-z0-9-]+)(?:\.(cpu|cuda|rocm))?$/;

export function addonProfileId(addon: string, variant: HardwareProfileVariant): string {
  return `addon.${addon}.${variant}`;
}

export function resolveHardwareProfileVariant(profileId: string): HardwareProfileVariant | null {
  return (profileId.match(PROFILE_ID_RE)?.[2] as HardwareProfileVariant | undefined) ?? null;
}

export function canonicalAddonProfileSelection(addon: string, profile: string): string {
  const trimmed = profile.trim();
  if (!trimmed) return '';

  const match = trimmed.match(PROFILE_ID_RE);
  if (!match || match[1] !== addon) return '';

  return trimmed;
}
