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

function validateEnvironment(name: string) {
  const result = Bun.spawnSync({
    cmd: [
      'bash',
      '-c',
      `source "$1"
while IFS= read -r inherited; do
  case "$inherited" in OP_*|COMPOSE_*) unset "$inherited" ;; esac
done < <(compgen -e)
export "$2=value"
validate_e2e_environment`,
      'bash',
      SCRIPT,
      name,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString('utf8'),
  };
}

function validateProjectName(value: string) {
  const result = Bun.spawnSync({
    cmd: [
      'bash',
      '-c',
      `source "$1"
OP_E2E_PROJECT_NAME="$2"
resolve_e2e_project_name || exit $?
printf '%s' "$COMPOSE_PROJECT_NAME"`,
      'bash',
      SCRIPT,
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

function validateProjectAbsence(resource: 'none' | 'container' | 'network' | 'volume') {
  const result = Bun.spawnSync({
    cmd: [
      'bash',
      '-c',
      `source "$1"
RESOURCE="$2"
docker() {
  case "$1" in
    ps) [[ "$RESOURCE" == container ]] && printf 'container-id\\n' ;;
    network) [[ "$RESOURCE" == network ]] && printf 'network-id\\n' ;;
    volume) [[ "$RESOURCE" == volume ]] && printf 'volume-name\\n' ;;
  esac
  return 0
}
assert_e2e_project_absent openpalm-e2e-test`,
      'bash',
      SCRIPT,
      resource,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
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

describe('dev E2E environment safety guard', () => {
  test('allows only explicit E2E inputs', () => {
    expect(validateEnvironment('OP_E2E_HOME')).toEqual({ exitCode: 0, stderr: '' });
    expect(validateEnvironment('OP_E2E_PROJECT_NAME')).toEqual({ exitCode: 0, stderr: '' });
    // #672: the tier-5 e2e stack needs its own workspace-port override so it
    // can run beside a local OpenPalm install (which binds the default 3820).
    expect(validateEnvironment('OP_E2E_WORKSPACE_PORT')).toEqual({ exitCode: 0, stderr: '' });
  });

  test('rejects inherited OpenPalm and Compose overrides', () => {
    for (const name of [
      'OP_HOME',
      'OP_ASSISTANT_BIND_ADDRESS',
      'COMPOSE_PROFILES',
      'COMPOSE_PROJECT_NAME',
      // #672: only the harness-owned OP_E2E_WORKSPACE_PORT may set this —
      // an inherited/direct OP_WORKSPACE_PORT stays refused, same as every
      // other raw compose override.
      'OP_WORKSPACE_PORT',
    ]) {
      const result = validateEnvironment(name);
      expect(result.exitCode, name).not.toBe(0);
      expect(result.stderr, name).toContain(`Refusing inherited Compose override: ${name}`);
    }
  });

  test('restricts project names to the E2E namespace', () => {
    expect(validateProjectName('openpalm-e2e-manual')).toEqual({
      exitCode: 0,
      stdout: 'openpalm-e2e-manual',
      stderr: '',
    });
    for (const name of ['openpalm', 'openpalm-prod', 'openpalm-e2e/escape']) {
      const result = validateProjectName(name);
      expect(result.exitCode, name).not.toBe(0);
      expect(result.stderr, name).toContain(`Refusing unsafe E2E project name: ${name}`);
    }
  });

  test('refuses existing project containers, networks, and volumes', () => {
    expect(validateProjectAbsence('none')).toEqual({ exitCode: 0, stderr: '' });
    for (const resource of ['container', 'network', 'volume'] as const) {
      const result = validateProjectAbsence(resource);
      expect(result.exitCode, resource).not.toBe(0);
      expect(result.stderr, resource).toContain(
        'Refusing existing E2E project resources: openpalm-e2e-test',
      );
    }
  });
});
