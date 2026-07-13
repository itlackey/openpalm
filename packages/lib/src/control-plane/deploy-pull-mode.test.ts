/**
 * PR #564 second retest R8 — compose `--pull` mode per image tag.
 *
 * `--pull missing` never refreshes a MOVING registry tag (`latest`) once the
 * image is present locally, so a moving-tag rerun can recreate the old digest.
 * resolvePullMode forces `--pull always` for a moving tag while keeping
 * `--pull missing` for an immutable pinned semver and for a locally-built dev
 * image (which must never hit the network).
 */
import { describe, expect, it } from 'bun:test';
import { resolvePullMode } from './deploy.js';

describe('resolvePullMode (R8)', () => {
  it('forces --pull always for the moving `latest` tag', () => {
    expect(resolvePullMode('latest')).toBe('always');
  });

  it('treats an unset/empty tag as moving (safe: refresh)', () => {
    expect(resolvePullMode('')).toBe('always');
  });

  it('treats a non-semver channel name as moving', () => {
    expect(resolvePullMode('edge')).toBe('always');
    expect(resolvePullMode('main')).toBe('always');
  });

  it('keeps --pull missing for an immutable pinned semver', () => {
    expect(resolvePullMode('v0.13.0')).toBe('missing');
    expect(resolvePullMode('0.13.0')).toBe('missing');
    expect(resolvePullMode('0.13.0-beta.3')).toBe('missing');
    expect(resolvePullMode('v1.2.3-rc.1')).toBe('missing');
  });

  it('keeps --pull missing for a locally-built dev image (never hits the network)', () => {
    expect(resolvePullMode('dev')).toBe('missing');
    expect(resolvePullMode('dev-abc123')).toBe('missing');
  });
});
