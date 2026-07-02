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

  test('guardrail script scans for ownership-changing helper commands', () => {
    expect(guardrailScript).toContain('gosu|usermod|groupmod|chown|chmod');
  });

  test('ownership smoke harness checks for root-owned files in isolated OP_HOME', () => {
    expect(smokeScript).toContain('system/stack/portals.compose.yml');
    expect(smokeScript).toContain('--profile addon.chat');
    expect(smokeScript).toContain('find "$SMOKE_HOME" -uid 0');
    expect(smokeScript).toContain('Rootless ownership smoke passed');
  });
});
