/**
 * #491 — standalone CLI entrypoint contract for the Slack portal package.
 * File-contract style mirrors containers/portal/start.test.ts (read files
 * relative to the package root via `new URL('../', import.meta.url)`), plus
 * one behavioral spawn smoke test.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));

function readRelative(path: string): string {
  return readFileSync(`${ROOT_DIR}/${path}`, 'utf8');
}

describe('slack portal bin contract (#491)', () => {
  test('package.json declares the bin entrypoint, ships bin/ in files, and stays Bun-only', () => {
    const pkg = JSON.parse(readRelative('package.json')) as {
      bin?: Record<string, string>;
      files?: string[];
      engines?: Record<string, string>;
    };

    expect(pkg.bin?.['openpalm-slack-portal']).toBe('bin/openpalm-slack-portal.ts');
    expect(pkg.files ?? []).toContain('bin');
    expect(pkg.files ?? []).toContain('src');
    expect(pkg.engines?.bun).toBeDefined();
  });

  test('bin wrapper has a bun shebang and boots the portal class', () => {
    const wrapper = readRelative('bin/openpalm-slack-portal.ts');

    expect(wrapper.startsWith('#!/usr/bin/env bun')).toBe(true);
    expect(wrapper).toContain(`from '../src/index.ts'`);
    expect(wrapper).toContain('.start()');
  });

  test('bin exits non-zero with startup_error when no principal secret is configured', async () => {
    const binPath = `${ROOT_DIR}/bin/openpalm-slack-portal.ts`;
    const proc = Bun.spawn(['bun', binPath], {
      env: { PATH: Bun.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toContain('startup_error');
  });

  test('README documents standalone use with the mandated security framing', () => {
    const readme = readRelative('README.md').toLowerCase();

    expect(readme).toContain('standalone');
    expect(readme).toContain('behind the openpalm guardian');
    expect(readme).toContain('personal / small-trusted-team');
    expect(readme).toContain('portal_session_reuse');
    expect(readme).toContain('bun');
  });
});
