export const PLATFORM_IMAGE_TAG_KEYS = [
  'OP_ASSISTANT_IMAGE_TAG',
  'OP_GUARDIAN_IMAGE_TAG',
  'OP_CHANNEL_IMAGE_TAG',
] as const;

export type PlatformImageTagKey = (typeof PLATFORM_IMAGE_TAG_KEYS)[number];

/**
 * Build the stack.env image-tag entries for a platform release.
 *
 * `tag` is the platform version-of-record (the assistant tag). Per-image
 * overrides let guardian/channel ride an older published tag when a release
 * shipped only a subset of images (#477). OP_IMAGE_TAG stays as the compose
 * fallback for pre-per-image installs.
 */
export function buildPlatformImageTagEnv(
  tag: string,
  perImage?: Partial<Record<PlatformImageTagKey, string>>,
): Record<string, string> {
  return {
    OP_IMAGE_TAG: tag,
    OP_ASSISTANT_IMAGE_TAG: perImage?.OP_ASSISTANT_IMAGE_TAG ?? tag,
    OP_GUARDIAN_IMAGE_TAG: perImage?.OP_GUARDIAN_IMAGE_TAG ?? tag,
    OP_CHANNEL_IMAGE_TAG: perImage?.OP_CHANNEL_IMAGE_TAG ?? tag,
  };
}
