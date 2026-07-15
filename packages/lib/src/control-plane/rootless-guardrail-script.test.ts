import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const guardrailScript = readFileSync(join(REPO_ROOT, 'scripts/validate-rootless-guardrails.sh'), 'utf8');
const smokeScript = readFileSync(join(REPO_ROOT, 'scripts/rootless-ownership-smoke.sh'), 'utf8');
const hostSwapSmokeScript = readFileSync(join(REPO_ROOT, 'scripts/rootless-host-swap-smoke.sh'), 'utf8');
const fixtureHelper = readFileSync(join(REPO_ROOT, 'scripts/rootless-smoke-fixture.sh'), 'utf8');
const ciWorkflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('rootless phase-0 script guardrails', () => {
  test('CI continues to invoke the rootless guardrail script', () => {
    expect(ciWorkflow).toContain('./scripts/validate-rootless-guardrails.sh');
  });

  test('CI also exercises the portal-specific ownership smoke path', () => {
    expect(ciWorkflow).toContain('./scripts/rootless-ownership-smoke.sh portal-discord');
  });

  test('CI exercises the host-swap smoke path', () => {
    expect(ciWorkflow).toContain('./scripts/rootless-host-swap-smoke.sh');
  });

  test('guardrail bans the root+privilege-drop re-exec helpers statically', () => {
    // gosu/usermod/groupmod have no legitimate use in a rootless container and
    // no spelling synonym, so a token grep is a meaningful guard.
    expect(guardrailScript).toContain('gosu|usermod|groupmod');
  });

  test('guardrail no longer greps entrypoints for chown/chmod (behavior smoke is the guard)', () => {
    // The chown|chmod token grep policed spelling, not behavior — it never
    // caught ownership-mutating equivalents (install -m, mkdir -m, cp
    // --preserve) and false-positived on legitimate non-root file writes.
    // scripts/rootless-ownership-smoke.sh boots the stack and fails on any
    // root-owned bind-mount file; that behavior test is the real guarantee.
    expect(guardrailScript).not.toContain('gosu|usermod|groupmod|chown|chmod');
  });

  test('guardrail error messages describe what is actually enforced (no phantom exceptions allowlist)', () => {
    expect(guardrailScript).not.toContain('temporary assistant/guardian exceptions');
  });

  test('ownership smoke harness validates root ownership and host bind-mount writes', () => {
    expect(smokeScript).toContain('system/stack/portals.compose.yml');
    expect(smokeScript).toContain('--profile addon.chat');
    expect(smokeScript).toContain('data/portal/tools/node_modules');
    expect(smokeScript).toContain('! -uid "$expected_uid" -o ! -gid "$expected_gid"');
    expect(smokeScript).toContain('Rootless ownership smoke passed');
  });

  test('host-swap smoke harness covers block and adopt-host flows', () => {
    expect(hostSwapSmokeScript).toContain('Expecting default start to block on host swap');
    expect(hostSwapSmokeScript).toContain('Verifying adopt-host repairs ownership and starts');
  });

  test('both smoke scripts source the shared fixture helper so the seed recipe cannot drift', () => {
    expect(smokeScript).toContain('rootless-smoke-fixture.sh');
    expect(smokeScript).toContain('smoke_seed_secrets');
    expect(hostSwapSmokeScript).toContain('rootless-smoke-fixture.sh');
    expect(hostSwapSmokeScript).toContain('smoke_seed_secrets');
  });

  test('shared fixture helper single-sources the secret seed, including discord_bot_token', () => {
    // host-swap previously omitted discord_bot_token; centralizing the recipe
    // here is what stops the two scripts from drifting again.
    expect(fixtureHelper).toContain('discord_bot_token');
    expect(fixtureHelper).toContain('smoke_copy_skeleton');
    expect(fixtureHelper).toContain('smoke_write_stack_env');
    expect(fixtureHelper).toContain('smoke_ensure_home_dirs');
  });

  test('rootless smoke fixtures no longer configure the removed assistant client runtime', () => {
    expect(fixtureHelper).not.toContain('OP_CLIENT_PORT=');
    expect(fixtureHelper).not.toContain('OP_CLIENT_VERSION');
    expect(smokeScript).not.toContain('OP_ROOTLESS_SMOKE_CLIENT_PORT');
    expect(hostSwapSmokeScript).not.toContain('3994');
    expect(fixtureHelper).toContain('OP_SKELETON_VERSION');
  });

  test('rootless smokes only run compose down when the prior stack env still exists', () => {
    expect(smokeScript).toContain('if [[ -f "$SMOKE_HOME/knowledge/env/stack.env" ]]');
    expect(hostSwapSmokeScript).toContain('if [[ -f "$SWAP_HOME/knowledge/env/stack.env" ]]');
  });

  // PR #564 retest P2-7: the PRE-run reset must be profile-aware too. `up` starts
  // profile-gated guardian/portal containers, so a plain `down` left a prior
  // `--keep` run's containers alive; deleting the fixture then dangled them. Both
  // the EXIT cleanup and the pre-run reset now go through one shared teardown
  // that enables both addon profiles AND a label backstop.
  test('pre-run reset shares the profile-aware teardown with the EXIT cleanup', () => {
    // One shared function, enabling both addon profiles + the label backstop.
    expect(smokeScript).toContain('smoke_teardown_stack() {');
    expect(smokeScript).toMatch(/smoke_teardown_stack\(\)[\s\S]*--profile addon\.discord --profile addon\.chat down/);
    expect(smokeScript).toMatch(/smoke_teardown_stack\(\)[\s\S]*label=com\.docker\.compose\.project=/);
    // Called from BOTH the cleanup path and the pre-run "Preparing" path — so the
    // pre-run reset can never regress to a bare profile-unaware `down`.
    expect(smokeScript).toMatch(/Preparing isolated smoke OP_HOME[\s\S]*smoke_teardown_stack/);
    const teardownCalls = smokeScript.match(/^\s*smoke_teardown_stack\s*$/gm) ?? [];
    expect(teardownCalls.length).toBeGreaterThanOrEqual(2);
    // The pre-run reset no longer runs a bare `dev_compose down` directly.
    expect(smokeScript).not.toMatch(/\n\s*dev_compose down --remove-orphans/);
  });
});
