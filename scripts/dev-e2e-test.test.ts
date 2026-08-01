import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';

const SCRIPT = join(import.meta.dir, 'dev-e2e-test.sh');
let sandbox = '';
let repoRoot = '';

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'openpalm-dev-e2e-guard-'));
  repoRoot = join(sandbox, 'repo');
  mkdirSync(join(repoRoot, '.cache'), { recursive: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function validateHome(mode: 'unset' | 'set', value = '') {
  const result = Bun.spawnSync({
    cmd: [
      'bash',
      '-c',
      `source "$1"
ROOT_DIR="$2"
if [[ "$3" == unset ]]; then unset OP_E2E_HOME; else OP_E2E_HOME="$4"; fi
canonicalize_e2e_home
printf '%s' "$OP_E2E_HOME"`,
      'bash',
      SCRIPT,
      repoRoot,
      mode,
      value,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
}

describe('dev E2E home safety guard', () => {
  test('canonicalizes the default and cache descendants', () => {
    expect(validateHome('unset')).toEqual({
      exitCode: 0,
      stdout: join(repoRoot, '.dev-e2e'),
      stderr: '',
    });

    const cacheHome = join(repoRoot, '.cache', 'playwright', '..', 'tier-5');
    expect(validateHome('set', cacheHome)).toEqual({
      exitCode: 0,
      stdout: join(repoRoot, '.cache', 'tier-5'),
      stderr: '',
    });
  });

  test('rejects empty and destructive locations', () => {
    for (const candidate of [
      '',
      repoRoot,
      '/',
      join(homedir(), '.openpalm'),
      join(repoRoot, '.cache'),
      join(repoRoot, '.dev-e2e', 'child'),
    ]) {
      const result = validateHome('set', candidate);
      expect(result.exitCode, candidate).not.toBe(0);
      expect(result.stderr, candidate).toMatch(/Refusing (empty|unsafe) OP_E2E_HOME/);
    }
  });

  test('rejects a cache path that escapes through a symlink', () => {
    const outside = join(sandbox, 'outside-cache');
    mkdirSync(outside);
    const link = join(repoRoot, '.cache', 'escape');
    symlinkSync(outside, link, 'dir');

    const result = validateHome('set', join(link, 'tier-5'));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`resolves to ${realpathSync(outside)}/tier-5`);
  });
});
