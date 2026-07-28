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
  test('captures container image IDs and restores them as local immutable tags', async () => {
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
      expect(calls.some((args) => args.join(' ').includes('image tag sha256:assistant example/assistant:rollback-generation-1'))).toBe(true);
      expect(calls.some((args) => args.join(' ').includes('image tag sha256:portal example/portal:rollback-generation-1'))).toBe(true);
      expect(calls.some((args) => args.join(' ').includes('image tag sha256:voice example/voice:rollback-generation-1-cpu'))).toBe(true);
      const restoredEnv = readFileSync(join(home, 'state', 'stack.env'), 'utf8');
      expect(restoredEnv).toContain('OP_ASSISTANT_VERSION=rollback-generation-1');
      expect(restoredEnv).toContain('OP_PORTAL_VERSION=rollback-generation-1');
      expect(restoredEnv).toContain('OP_VOICE_VERSION=rollback-generation-1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
