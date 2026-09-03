import { patchStateEnvFile } from './secrets.js';
import { buildComposeCommandArgs, realDockerClient, type DockerClient } from './docker.js';
import type { ControlPlaneState } from './types.js';

export type RunningImageSnapshot = Record<string, { imageId: string; image: string }>;

/** Capture immutable image IDs before an upgrade can pull or recreate anything. */
export async function captureRunningImageIds(
  options: { files: string[]; envFiles?: string[]; profiles?: string[] },
  docker: DockerClient = realDockerClient,
): Promise<RunningImageSnapshot> {
  const base = ['compose', ...buildComposeCommandArgs(options)];
  // `-a`: a container that EXITED during a failed upgrade is still the image
  // this home was running, and is exactly what rollback has to restore.
  const ps = await docker.run([...base, 'ps', '-a', '-q']);
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

/**
 * Put the previously-running images back, by writing their REAL tags into
 * `state/stack.env` as ordinary operator pins (#639, reworked for #679).
 *
 * It used to mint a synthetic `rollback-generation-<id>` tag per image and
 * write that instead. Three problems, all real: three other call sites had to
 * recognise the value by string-sniffing `startsWith('rollback-')`; only a
 * later SUCCESSFUL update ever cleared it, and nothing ever cleared voice's;
 * and every failed upgrade left orphan local tags that nothing reaps.
 *
 * A real release tag needs none of that. `openpalm/assistant:0.13.1` is still
 * in the local store and is still pullable (the release workflow refuses to
 * republish over an existing tag), the recovery `up` runs with
 * `pull: 'missing'`, and the row it leaves behind is an ordinary pin the
 * operator clears by clearing the field — which `openpalm update` names on
 * every subsequent run.
 *
 * A MOVING ref (`voice:latest-cpu`, or a dev `:dev`) is re-tagged onto the
 * captured image ID first, because the failed attempt's `pull: 'always'` may
 * have repointed those bytes. That is best-effort: a mutable alias can be moved
 * again by the next pull, which is weaker than the platform images' guarantee
 * and is stated rather than hidden.
 */
export async function restoreRunningImageIds(
  state: ControlPlaneState,
  snapshot: RunningImageSnapshot,
  _generation: string,
  docker: DockerClient = realDockerClient,
): Promise<void> {
  const updates: Record<string, string> = {};
  for (const image of Object.values(snapshot)) {
    const withoutDigest = image.image.split('@', 1)[0] ?? '';
    const lastSlash = withoutDigest.lastIndexOf('/');
    const lastColon = withoutDigest.lastIndexOf(':');
    const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
    const imageName = repository.split('/').at(-1);
    const tag = lastColon > lastSlash ? withoutDigest.slice(lastColon + 1) : '';
    const key = imageName === 'assistant' ? 'OP_ASSISTANT_VERSION' : imageName === 'guardian' ? 'OP_GUARDIAN_VERSION' : imageName === 'portal' ? 'OP_PORTAL_VERSION' : imageName === 'voice' ? 'OP_VOICE_VERSION' : null;
    if (!imageName || !key || !tag) continue;

    // Voice's key holds the BASE tag; compose appends `-cpu`/`-cu121`/`-rocm6`.
    const voiceVariant = imageName === 'voice' ? tag.match(/-(?:cpu|cu\d+|rocm\d+)$/)?.[0] : undefined;
    updates[key] = voiceVariant ? tag.slice(0, -voiceVariant.length) : tag;

    // Only a moving alias can have been repointed under us; an exact release
    // tag still names the bytes it named before the failed pull.
    if (tag === 'latest' || tag === 'next' || tag.startsWith('dev') || voiceVariant) {
      await docker.run(['image', 'tag', image.imageId, withoutDigest]);
    }
  }
  if (Object.keys(updates).length > 0) patchStateEnvFile(state.homeDir, updates);
}
