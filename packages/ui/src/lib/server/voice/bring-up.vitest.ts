import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  _resetJobs,
  getActiveJob,
  isLargeImageTag,
  resolveDefaultProfile,
  setJob,
} from './bring-up.js';
import { addonProfileId, type AddonProfile } from '@openpalm/lib';

afterEach(() => {
  _resetJobs();
});

// (2.2) buildCdiOverlayYaml / buildRootlessOverlayYaml were deleted: the
// overlays they generated now ship as static files in the skeleton's managed
// tree, verified directly against packages/skeleton/system/stack/ below —
// there is no generator left to unit-test here.
describe('static voice fallback overlays (packages/skeleton/system/stack/)', () => {
  const skeletonStackDir = join(import.meta.dirname, '..', '..', '..', '..', '..', 'skeleton', 'system', 'stack');

  test('voice.compose.cdi.yml rewrites voice-cuda to the CDI device reservation form', () => {
    const path = join(skeletonStackDir, 'voice.compose.cdi.yml');
    expect(existsSync(path)).toBe(true);
    const yaml = readFileSync(path, 'utf-8');
    expect(yaml).toContain('services:');
    expect(yaml).toContain('  voice-cuda:');
    // Legacy runtime is cleared and the CDI driver reservation is added.
    expect(yaml).toContain('    runtime: ""');
    expect(yaml).toContain('- driver: cdi');
    expect(yaml).toContain('- nvidia.com/gpu=all');
  });

  test('voice.compose.rootless.yml restores the image-default user for all three voice variants', () => {
    const path = join(skeletonStackDir, 'voice.compose.rootless.yml');
    expect(existsSync(path)).toBe(true);
    const yaml = readFileSync(path, 'utf-8');
    for (const svc of ['voice', 'voice-cuda', 'voice-rocm']) {
      expect(yaml).toContain(`  ${svc}:`);
    }
    expect(yaml.match(/user: ""/g)?.length).toBe(3);
  });
});

describe('isLargeImageTag', () => {
  test('matches the multi-GB voice accelerator + cpu tags', () => {
    expect(isLargeImageTag('openpalm/voice:latest-cu121')).toBe(true);
    expect(isLargeImageTag('openpalm/voice:latest-rocm6')).toBe(true);
    expect(isLargeImageTag('openpalm/voice:latest-cpu')).toBe(true);
  });
  test('ignores small / untagged images', () => {
    expect(isLargeImageTag('openpalm/voice:latest')).toBe(false);
    expect(isLargeImageTag('')).toBe(false);
    expect(isLargeImageTag('nginx:alpine')).toBe(false);
  });
});

describe('resolveDefaultProfile', () => {
  const cpu = addonProfileId('voice', 'cpu');
  const cuda = addonProfileId('voice', 'cuda');
  const mk = (over: Partial<AddonProfile> & { id: string }): AddonProfile =>
    ({ label: over.id, services: [over.id], ...over }) as AddonProfile;

  test('returns null for an empty list', () => {
    expect(resolveDefaultProfile([])).toBeNull();
  });

  test('prefers an available GPU profile over the labelled default', () => {
    const profiles = [
      mk({ id: cpu, default: true, available: true }),
      mk({ id: cuda, available: true }),
    ];
    expect(resolveDefaultProfile(profiles)).toBe(cuda);
  });

  test('falls back to the labelled default when the GPU profile is unavailable', () => {
    const profiles = [
      mk({ id: cpu, default: true, available: true }),
      mk({ id: cuda, available: false }),
    ];
    expect(resolveDefaultProfile(profiles)).toBe(cpu);
  });

  test('falls back to the first available profile when none is labelled default', () => {
    const profiles = [
      mk({ id: cpu, available: false }),
      mk({ id: cuda, available: true }),
    ];
    expect(resolveDefaultProfile(profiles)).toBe(cuda);
  });

  test('falls back to the first profile when nothing is available', () => {
    const profiles = [
      mk({ id: cpu, available: false }),
      mk({ id: cuda, available: false }),
    ];
    expect(resolveDefaultProfile(profiles)).toBe(cpu);
  });
});

describe('job registry', () => {
  test('setJob seeds a fresh job then merges patches', () => {
    const first = setJob('voice', { state: 'pulling' });
    expect(first.state).toBe('pulling');
    expect(first.steps).toEqual([]);
    expect(typeof first.startedAt).toBe('number');

    const merged = setJob('voice', { state: 'starting', steps: [{ step: 'enable', ok: true }] });
    // startedAt is preserved across the merge.
    expect(merged.startedAt).toBe(first.startedAt);
    expect(merged.state).toBe('starting');
    expect(merged.steps).toEqual([{ step: 'enable', ok: true }]);
  });

  test('getActiveJob returns the live job and drops one past its retention window', () => {
    setJob('voice', { state: 'healthy', finishedAt: Date.now() });
    expect(getActiveJob('voice')?.state).toBe('healthy');

    // Backdate the finish time well past the 5-minute retention window.
    setJob('voice', { finishedAt: Date.now() - 10 * 60_000 });
    expect(getActiveJob('voice')).toBeUndefined();
    // Expired jobs are evicted, so a second read is still undefined.
    expect(getActiveJob('voice')).toBeUndefined();
  });

  test('getActiveJob returns undefined for an unknown addon', () => {
    expect(getActiveJob('nope')).toBeUndefined();
  });
});
