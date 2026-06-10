export const PLATFORM_IMAGE_TAG_KEYS = [
  'OP_ASSISTANT_IMAGE_TAG',
  'OP_GUARDIAN_IMAGE_TAG',
  'OP_CHANNEL_IMAGE_TAG',
] as const;

export type PlatformImageTagKey = (typeof PLATFORM_IMAGE_TAG_KEYS)[number];

export function buildPlatformImageTagEnv(tag: string): Record<string, string> {
  return {
    OP_IMAGE_TAG: tag,
    OP_ASSISTANT_IMAGE_TAG: tag,
    OP_GUARDIAN_IMAGE_TAG: tag,
    OP_CHANNEL_IMAGE_TAG: tag,
  };
}
