import { defineCommand } from 'citty';
import {
  buildPinnedImagesValue,
  createState,
  initializeStateSecrets,
  mergeEnvContent,
  parseEnvFile,
  parsePinnedImages,
  platformImageTagKeyFor,
  removeEnvKey,
  type PinnablePlatformImage,
} from '@openpalm/lib';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function selectedImages(args: { guardian?: string | boolean; portal?: string | boolean }): PinnablePlatformImage[] {
  return [
    ...(args.guardian ? ['guardian' as const] : []),
    ...(args.portal ? ['portal' as const] : []),
  ];
}

export default defineCommand({
  meta: {
    name: 'pin',
    description: 'Pin guardian/portal image tags in stack.env',
  },
  args: {
    guardian: {
      type: 'string',
      description: 'Pin guardian to an explicit image tag',
    },
    portal: {
      type: 'string',
      description: 'Pin portal to an explicit image tag',
    },
    unpin: {
      type: 'boolean',
      description: 'Remove the selected image pins',
      default: false,
    },
  },
  async run({ args }) {
    const images = selectedImages(args);
    if (images.length === 0) {
      console.error('Select at least one target: --guardian <tag> and/or --portal <tag> (or use --unpin).');
      process.exit(1);
    }

    if (!args.unpin) {
      for (const image of images) {
        const value = args[image];
        if (typeof value !== 'string' || !value.trim()) {
          console.error(`--${image} requires a non-empty tag unless --unpin is used.`);
          process.exit(1);
        }
      }
    }

    const state = createState();
    initializeStateSecrets(state);
    const stackEnvPath = `${state.stashDir}/env/stack.env`;
    const currentEnv = parseEnvFile(stackEnvPath);
    const currentContent = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, 'utf-8') : '';
    const pinned = new Set(parsePinnedImages(currentEnv.OP_PINNED_IMAGES));

    let nextContent = currentContent;

    if (args.unpin) {
      for (const image of images) pinned.delete(image);
    } else {
      const updates: Record<string, string> = {};
      for (const image of images) {
        pinned.add(image);
        updates[platformImageTagKeyFor(image)] = String(args[image]).trim();
      }
      nextContent = mergeEnvContent(nextContent, updates);
    }

    const pinnedValue = buildPinnedImagesValue(pinned);
    nextContent = pinnedValue
      ? mergeEnvContent(nextContent, { OP_PINNED_IMAGES: pinnedValue })
      : removeEnvKey(nextContent, 'OP_PINNED_IMAGES');

    writeFileSync(stackEnvPath, nextContent);
    console.log(JSON.stringify({
      ok: true,
      pinnedImages: [...pinned],
      stackEnvPath,
    }, null, 2));
  },
});
