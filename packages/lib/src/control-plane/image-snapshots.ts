import { readStackEnv, patchStateEnvFile } from './secrets.js';
import { buildComposeCommandArgs, realDockerClient, type DockerClient } from './docker.js';
import type { ControlPlaneState } from './types.js';

export type RunningImageSnapshot = Record<string, { imageId: string; image: string }>;

/** Capture immutable image IDs before an upgrade can pull or recreate anything. */
export async function captureRunningImageIds(
  options: { files: string[]; envFiles?: string[]; profiles?: string[] },
  docker: DockerClient = realDockerClient,
): Promise<RunningImageSnapshot> {
  const base = ['compose', ...buildComposeCommandArgs(options)];
  const ps = await docker.run([...base, 'ps', '-q']);
  if (!ps.ok) return {};
  const ids = ps.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) return {};
  const inspected = await docker.run(['inspect', '--format', '{{json .}}', ...ids]);
  if (!inspected.ok) return {};
  const result: RunningImageSnapshot = {};
  for (const line of inspected.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const value = JSON.parse(line) as { Image?: unknown; Config?: { Labels?: Record<string, unknown>; Image?: unknown } };
      const labels = value.Config?.Labels ?? {};
      const service = typeof labels['com.docker.compose.service'] === 'string' ? labels['com.docker.compose.service'] : '';
      if (service && typeof value.Image === 'string' && typeof value.Config?.Image === 'string') {
        result[service] = { imageId: value.Image, image: value.Config.Image };
      }
    } catch { /* ignore an individual inspect row */ }
  }
  return result;
}

/** Tag old image IDs locally and persist those immutable refs for rollback. */
export async function restoreRunningImageIds(
  state: ControlPlaneState,
  snapshot: RunningImageSnapshot,
  generation: string,
  docker: DockerClient = realDockerClient,
): Promise<void> {
  const env = readStackEnv(state.homeDir);
  const namespace = env.OP_IMAGE_NAMESPACE?.trim() || 'openpalm';
  const updates: Record<string, string> = {};
  for (const [service, image] of Object.entries(snapshot)) {
    const tag = `rollback-${generation.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
    const withoutDigest = image.image.split('@', 1)[0] ?? '';
    const lastSlash = withoutDigest.lastIndexOf('/');
    const lastColon = withoutDigest.lastIndexOf(':');
    const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
    const imageName = repository.split('/').at(-1);
    const originalTag = lastColon > lastSlash ? withoutDigest.slice(lastColon + 1) : '';
    const voiceVariant = imageName === 'voice' ? originalTag.match(/-(cpu|cu121|rocm6)$/)?.[1] : undefined;
    const key = imageName === 'assistant' ? 'OP_ASSISTANT_VERSION' : imageName === 'guardian' ? 'OP_GUARDIAN_VERSION' : imageName === 'portal' ? 'OP_PORTAL_VERSION' : imageName === 'voice' ? 'OP_VOICE_VERSION' : null;
    if (!imageName || !key) continue;
    const rollbackImageTag = voiceVariant ? `${tag}-${voiceVariant}` : tag;
    const ref = `${namespace}/${imageName}:${rollbackImageTag}`;
    const tagged = await docker.run(['image', 'tag', image.imageId, ref]);
    if (!tagged.ok) throw new Error(`Failed to preserve rollback image for ${service}: ${tagged.stderr || tagged.code}`);
    updates[key] = tag;
  }
  if (Object.keys(updates).length > 0) patchStateEnvFile(state.homeDir, updates);
}
