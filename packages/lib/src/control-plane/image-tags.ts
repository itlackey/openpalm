export const PLATFORM_IMAGE_TAG_KEYS = [
  'OP_ASSISTANT_IMAGE_TAG',
  'OP_GUARDIAN_IMAGE_TAG',
  'OP_PORTAL_IMAGE_TAG',
] as const;

export type PlatformImageTagKey = (typeof PLATFORM_IMAGE_TAG_KEYS)[number];

export const PINNABLE_PLATFORM_IMAGES = ['guardian', 'portal'] as const;

export type PinnablePlatformImage = (typeof PINNABLE_PLATFORM_IMAGES)[number];

const PINNABLE_PLATFORM_IMAGE_SET = new Set<string>(PINNABLE_PLATFORM_IMAGES);

export function parsePinnedImages(value: string | undefined): PinnablePlatformImage[] {
  if (!value) return [];

  return [...new Set(
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry): entry is PinnablePlatformImage => PINNABLE_PLATFORM_IMAGE_SET.has(entry)),
  )].sort() as PinnablePlatformImage[];
}

export function buildPinnedImagesValue(images: Iterable<PinnablePlatformImage>): string {
  return [...new Set(images)].sort().join(',');
}

export function platformImageTagKeyFor(image: PinnablePlatformImage): PlatformImageTagKey {
  switch (image) {
    case 'guardian':
      return 'OP_GUARDIAN_IMAGE_TAG';
    case 'portal':
      return 'OP_PORTAL_IMAGE_TAG';
  }
}

export function resolveEffectivePlatformImageTag(env: Record<string, string>, image: PinnablePlatformImage): string {
  const primary = env[platformImageTagKeyFor(image)]?.trim();
  if (primary) return primary;
  if (image === 'portal') {
    const legacy = env.OP_CHANNEL_IMAGE_TAG?.trim();
    if (legacy) return legacy;
  }
  return env.OP_IMAGE_TAG?.trim() || 'latest';
}

export function buildPinnedImageTagEnv(
  env: Record<string, string>,
  pinnedImages: Iterable<PinnablePlatformImage>,
): Partial<Record<PlatformImageTagKey, string>> {
  const updates: Partial<Record<PlatformImageTagKey, string>> = {};
  for (const image of pinnedImages) {
    updates[platformImageTagKeyFor(image)] = resolveEffectivePlatformImageTag(env, image);
  }
  return updates;
}

// ── Deployable units (independent release units with their own Docker image) ──
//
// Each unit has its own Docker image tagged independently (v-prefixed semver).
// The `portals` unit publishes the `openpalm/portal` image (singular), so the
// unit name and image name diverge there. Voice is a separate image only when
// the voice addon is enabled. The platform unit is npm-only — no Docker image —
// so it is intentionally absent from this list.

export const DEPLOYABLE_UNITS = ['assistant', 'guardian', 'portals', 'voice'] as const;

export type DeployableUnit = (typeof DEPLOYABLE_UNITS)[number];

const DEPLOYABLE_UNIT_IMAGE_NAMES: Record<DeployableUnit, string> = {
  assistant: 'assistant',
  guardian: 'guardian',
  portals: 'portal',
  voice: 'voice',
};

const DEPLOYABLE_UNIT_IMAGE_TAG_KEYS: Record<DeployableUnit, string> = {
  assistant: 'OP_ASSISTANT_IMAGE_TAG',
  guardian: 'OP_GUARDIAN_IMAGE_TAG',
  portals: 'OP_PORTAL_IMAGE_TAG',
  voice: 'OP_VOICE_IMAGE_TAG',
};

export function isDeployableUnit(value: string): value is DeployableUnit {
  return (DEPLOYABLE_UNITS as readonly string[]).includes(value);
}

export function deployableUnitImageName(unit: DeployableUnit): string {
  return DEPLOYABLE_UNIT_IMAGE_NAMES[unit];
}

export function deployableUnitImageTagKey(unit: DeployableUnit): string {
  return DEPLOYABLE_UNIT_IMAGE_TAG_KEYS[unit];
}

/**
 * Build the stack.env image-tag entries for a platform release.
 *
 * `tag` is the platform version-of-record (the assistant tag). Per-image
 * overrides let guardian/portal ride an older published tag when a release
 * shipped only a subset of images (#477). OP_IMAGE_TAG stays as the compose
 * fallback for pre-per-image installs.
 */
export function buildPlatformImageTagEnv(
  tag: string,
  perImage?: Partial<Record<PlatformImageTagKey | 'OP_CHANNEL_IMAGE_TAG', string>>,
  pinnedImages: Iterable<PinnablePlatformImage> = [],
): Record<string, string> {
  const pinned = new Set(pinnedImages);
  return {
    OP_IMAGE_TAG: tag,
    OP_ASSISTANT_IMAGE_TAG: perImage?.OP_ASSISTANT_IMAGE_TAG ?? tag,
    ...(pinned.has('guardian') ? {} : { OP_GUARDIAN_IMAGE_TAG: perImage?.OP_GUARDIAN_IMAGE_TAG ?? tag }),
    ...(pinned.has('portal') ? {} : { OP_PORTAL_IMAGE_TAG: perImage?.OP_PORTAL_IMAGE_TAG ?? perImage?.OP_CHANNEL_IMAGE_TAG ?? tag }),
  };
}
