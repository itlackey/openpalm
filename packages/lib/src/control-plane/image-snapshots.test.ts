import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRunningImageIds, restoreRunningImageIds } from './image-snapshots.js';
import type { ControlPlaneState } from './types.js';

function state(homeDir: string): ControlPlaneState {
  return { homeDir, configDir: join(homeDir, 'config'), stashDir: join(homeDir, 'knowledge'), workspaceDir: join(homeDir, 'workspace'), dataDir: join(homeDir, 'data'), stackDir: join(homeDir, 'system', 'stack'), services: {}, artifacts: { compose: '' }, artifactMeta: [] };
}

describe('immutable running image snapshots', () => {
  test('captures container image IDs and restores them by pinning the tags that were running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-image-snapshot-'));
    try {
      mkdirSync(join(home, 'state'), { recursive: true });
      const envFile = join(home, 'state', 'stack.env');
      writeFileSync(envFile, 'OP_PROJECT_NAME=custom-project\nOP_IMAGE_NAMESPACE=example\nOP_ASSISTANT_VERSION=0.13.0\n');
      const calls: string[][] = [];
      const docker = { run: async (args: string[]) => {
        calls.push(args);
        if (args.includes('ps')) return { ok: true, stdout: 'container-1\n', stderr: '', code: 0 };
        if (args.includes('inspect')) return { ok: true, stdout: [
          '{"Image":"sha256:assistant","Config":{"Image":"example/assistant:0.13.0","Labels":{"com.docker.compose.service":"assistant"}}}',
          '{"Image":"sha256:portal","Config":{"Image":"example/portal:0.13.0","Labels":{"com.docker.compose.service":"discord"}}}',
          '{"Image":"sha256:voice","Config":{"Image":"example/voice:0.13.0-cpu","Labels":{"com.docker.compose.service":"voice-cpu"}}}',
        ].join('\n'), stderr: '', code: 0 };
        return { ok: true, stdout: '', stderr: '', code: 0 };
      } };
      const images = await captureRunningImageIds({ files: ['/tmp/core.yml'], envFiles: [envFile] }, docker);
      await restoreRunningImageIds(state(home), images, 'generation-1', docker);
      expect(images.assistant?.imageId).toBe('sha256:assistant');
      expect(calls[0]).toContain('custom-project');

      // #679: recovery pins the REAL tags that were running, not a synthetic
      // `rollback-generation-*` alias. A real release tag is still pullable, is
      // recognisable to the operator, needs no string-sniffing by three other
      // call sites, and leaves no orphan local tags behind.
      const restoredEnv = readFileSync(join(home, 'state', 'stack.env'), 'utf8');
      expect(restoredEnv).toContain('OP_ASSISTANT_VERSION=0.13.0');
      expect(restoredEnv).toContain('OP_PORTAL_VERSION=0.13.0');
      expect(restoredEnv).not.toContain('rollback-generation-');
      // Voice's key holds the BASE tag; compose appends the accelerator suffix.
      expect(restoredEnv).toContain('OP_VOICE_VERSION=0.13.0');

      // An exact release tag still names the same bytes, so it needs no
      // re-tagging. Only a MOVING alias could have been repointed by the failed
      // attempt's pull — here, voice's variant tag.
      expect(calls.some((args) => args.join(' ').includes('image tag sha256:assistant'))).toBe(false);
      expect(calls.some((args) => args.join(' ').includes('image tag sha256:voice example/voice:0.13.0-cpu'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
