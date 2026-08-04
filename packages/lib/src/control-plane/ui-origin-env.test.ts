/**
 * The UI child must never be handed an empty ORIGIN.
 *
 * adapter-node's `parse_origin` accepts a valid absolute URL or `undefined`
 * and throws on everything else — including the empty string — and it runs at
 * MODULE LOAD, so a bad value does not degrade a request, it kills the server
 * before it listens. The assistant healthcheck curls the UI on :3000, so the
 * whole container then reports unhealthy and a compose deploy fails with
 * "dependency failed to start".
 *
 * core.compose.yml passes `ORIGIN: ${OP_UI_ORIGIN:-}` so an operator can pin
 * the browser origin on a plain-HTTP LAN install (adapter-node otherwise
 * defaults the protocol to https when no x-forwarded-proto arrives). That
 * makes EMPTY the default state, not an edge case — every deployment that has
 * not set OP_UI_ORIGIN goes down this path — so start_ui has to drop the
 * variable rather than forward it.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

/**
 * Run start_ui's ORIGIN guard exactly as entrypoint.sh spells it, and report
 * whether the child process would see the variable at all.
 */
function childSeesOrigin(origin: string | undefined): { present: boolean; value?: string } {
  const script = `
    origin_env_args=()
    if [ -z "\${ORIGIN:-}" ]; then
      origin_env_args=(-u ORIGIN)
    fi
    env "\${origin_env_args[@]}" node -e 'process.stdout.write(JSON.stringify({present: "ORIGIN" in process.env, value: process.env.ORIGIN}))'
  `;
  const env = { ...process.env };
  if (origin === undefined) delete env.ORIGIN;
  else env.ORIGIN = origin;
  return JSON.parse(execFileSync('bash', ['-c', script], { env, encoding: 'utf8' }));
}

describe('assistant entrypoint — UI ORIGIN handling', () => {
  it('drops an empty ORIGIN so adapter-node falls back instead of throwing', () => {
    expect(childSeesOrigin('')).toEqual({ present: false });
  });

  it('drops an unset ORIGIN', () => {
    expect(childSeesOrigin(undefined)).toEqual({ present: false });
  });

  it('forwards a real ORIGIN so the operator knob still works', () => {
    expect(childSeesOrigin('http://palm.local:3810')).toEqual({
      present: true,
      value: 'http://palm.local:3810',
    });
  });

  it('start_ui actually carries the guard the cases above model', () => {
    const entrypoint = read('containers/assistant/entrypoint.sh');
    expect(entrypoint).toContain('origin_env_args=(-u ORIGIN)');
    // The guard is worthless unless it is applied to the exec that starts the
    // UI, so pin the two together rather than just the declaration.
    expect(entrypoint).toMatch(/env -u OP_ENABLE_ADMIN -u OP_INSIDE_ELECTRON "\$\{origin_env_args\[@\]\}"/);
  });

  it('compose still lets an operator pin the origin', () => {
    const compose = read('packages/skeleton/system/stack/core.compose.yml');
    expect(compose).toMatch(/ORIGIN: \$\{OP_UI_ORIGIN:-\}/);
  });
});
