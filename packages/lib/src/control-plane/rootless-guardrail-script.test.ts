import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const guardrailScript = readFileSync(join(REPO_ROOT, 'scripts/validate-rootless-guardrails.sh'), 'utf8');
const smokeScript = readFileSync(join(REPO_ROOT, 'scripts/rootless-ownership-smoke.sh'), 'utf8');
const ciWorkflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('rootless phase-0 script guardrails', () => {
  test('CI continues to invoke the rootless guardrail script', () => {
    expect(ciWorkflow).toContain('./scripts/validate-rootless-guardrails.sh');
  });

  test('CI also exercises the portal-specific ownership smoke path', () => {
    expect(ciWorkflow).toContain('./scripts/rootless-ownership-smoke.sh portal-discord');
  });

  test('guardrail script scans for ownership-changing helper commands', () => {
    expect(guardrailScript).toContain('gosu|usermod|groupmod|chown|chmod');
  });

  test('ownership smoke harness validates root ownership and host bind-mount writes', () => {
    expect(smokeScript).toContain('system/stack/portals.compose.yml');
    expect(smokeScript).toContain('--profile addon.chat');
    expect(smokeScript).toContain('data/portal/tools/node_modules');
    expect(smokeScript).toContain('! -uid "$expected_uid" -o ! -gid "$expected_gid"');
    expect(smokeScript).toContain('Rootless ownership smoke passed');
  });
});
