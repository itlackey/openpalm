import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const guardianEntrypoint = readFileSync(join(REPO_ROOT, 'containers/guardian/entrypoint.sh'), 'utf8');
const guardianDockerfile = readFileSync(join(REPO_ROOT, 'containers/guardian/Dockerfile'), 'utf8');
const portalsCompose = readFileSync(
  join(REPO_ROOT, 'packages/skeleton/system/stack/portals.compose.yml'),
  'utf8',
);

describe('guardian rootless entrypoint regressions', () => {
  test('artifact installs run directly as the container user (no privilege wrapper)', () => {
    expect(guardianEntrypoint).toContain('( cd "$prefix" && bun add "${pkg}@${version}" --production )');
    // S.4: tools are exact-pinned now (containers/guardian/tools/package.json),
    // so boot no longer silently advances them within a semver range via
    // `bun update` — it runs a plain, idempotent `bun install` instead.
    expect(guardianEntrypoint).toContain('bun install --cwd /opt/openpalm/tools --production');
    expect(guardianEntrypoint).not.toContain('bun update --cwd /opt/openpalm/tools --production');
    expect(guardianEntrypoint).not.toContain('run_as_target_user');
  });

  test('the baked guardian package install prefix is never shadowed by the shipped guardian bind-mounts', () => {
    // S.4 regression: compose bind-mounts OP_HOME/data/guardian over
    // /opt/openpalm/guardian for runtime state (nonce/rate-limit store,
    // OpenCode auth/config) — $HOME for the guardian process. A bind-mount
    // NEVER seeds from the image, so if the guardian npm package were baked
    // at that same path, an empty host directory there would silently force
    // a network re-fetch on every real deployment even though the image has
    // the package baked in (a bare `docker run` with no such mount would
    // never catch this). The install prefix must live at a path with no
    // bind-mount over it in the shipped compose.
    const installMatch = guardianEntrypoint.match(
      /install_artifact "\$OP_GUARDIAN_PACKAGE" "\$VERSION" (\S+)/,
    );
    expect(installMatch).not.toBeNull();
    const installPrefix = installMatch![1];

    const bakeMatch = guardianDockerfile.match(
      /\(cd (\S+) && bun add "\$guardian_spec"/,
    );
    expect(bakeMatch).not.toBeNull();
    const bakePrefix = bakeMatch![1];

    // Both build-time bake and boot-time install/skip-check must agree on
    // the same prefix, or the already-at-version check in install_artifact()
    // would never find the baked package.
    expect(installPrefix).toBe(bakePrefix);

    // Extract the guardian service's volume bind-mount targets from the
    // shipped compose file (the block between `  guardian:` and the next
    // top-level `secrets:`/`volumes:` key).
    const guardianServiceMatch = portalsCompose.match(/\n {2}guardian:\n([\s\S]*?)\n(?=\S)/);
    expect(guardianServiceMatch).not.toBeNull();
    const guardianServiceBlock = guardianServiceMatch![1];
    const mountTargets = [...guardianServiceBlock.matchAll(/- \S+:(\/opt\/openpalm\S*)/g)].map(
      (m) => m[1],
    );
    expect(mountTargets.length).toBeGreaterThan(0);
    expect(mountTargets).not.toContain(installPrefix);
    // The known state bind-mount is still expected to be present and must
    // differ from the package install prefix.
    expect(mountTargets).toContain('/opt/openpalm/guardian');
    expect(installPrefix).not.toBe('/opt/openpalm/guardian');
  });
});
