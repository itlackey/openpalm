/**
 * CI ratchet for the image-baked-only model (#581 Recommended Change 1, E2/S2).
 *
 * These assertions pass at introduction — that is the point. They exist to fail
 * LATER, if someone reintroduces the two patterns that caused the production
 * disk-exhaustion incident:
 *
 *   1. Installing or updating packages at container boot. That is what made
 *      "same image tag" stop meaning "same running code", and what regenerated
 *      GBs of cache on every restart.
 *   2. Mounting anything over the image's baked artifact paths. A mount there
 *      hides the image's own content, which is how an upgraded container ended
 *      up silently running the previous release's code (#585).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');

/** Strip comments so prose describing a forbidden pattern is not a violation. */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .filter((line) => line.trim().length > 0);
}

describe('entrypoints do not install packages at boot', () => {
  // The guardian is the one exception: install_artifact exists so a downstream
  // distribution can pin OP_GUARDIAN_NPM_VERSION to something the image did not
  // bake. In the shipped case its semver check makes it a no-op with no network.
  const cases: Array<{ file: string; allowInstallArtifact: boolean }> = [
    { file: 'containers/assistant/entrypoint.sh', allowInstallArtifact: false },
    { file: 'containers/portal/start.sh', allowInstallArtifact: false },
    { file: 'containers/guardian/entrypoint.sh', allowInstallArtifact: true },
  ];

  for (const { file, allowInstallArtifact } of cases) {
    it(`${file} runs no package install/update at boot`, () => {
      const offenders = codeLines(read(file)).filter((line) => {
        if (!/\b(bun (install|add|update)|npm (install|ci|update)|yarn add|pnpm (add|install))\b/.test(line)) {
          return false;
        }
        // The guardian's override path routes through install_artifact, whose
        // single install line is fully parameterized (`bun add "${pkg}@${version}"`).
        // A concrete package name here would NOT match, which is the point:
        // this permits the existing seam, not new hardcoded installs.
        if (allowInstallArtifact && /\$\{pkg\}@\$\{version\}/.test(line)) return false;
        return true;
      });

      expect(offenders).toEqual([]);
    });
  }
});

describe('nothing is mounted over the image-baked artifact paths', () => {
  // Everything the images bake and serve from. A bind or volume landing on any
  // of these hides the image's own copy — the #585 stale-artifact bug.
  const BAKED_ARTIFACT_TARGETS = [
    '/opt/openpalm',
    '/opt/openpalm/tools',
    '/opt/openpalm/ui',
    '/opt/openpalm/skeleton',
    '/opt/openpalm/guardian-pkg',
  ];

  const composeFiles = [
    'packages/skeleton/system/stack/core.compose.yml',
    'packages/skeleton/system/stack/portals.compose.yml',
    'packages/skeleton/system/stack/services.compose.yml',
  ];

  for (const file of composeFiles) {
    it(`${file} mounts nothing over a baked artifact path`, () => {
      const offenders = codeLines(read(file))
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- '))
        .filter((line) => {
          // Short-form mount: "- <source>:<target>[:<mode>]". The target is the
          // second colon-separated field.
          const target = line.replace(/^-\s*/, '').split(':')[1];
          return target !== undefined && BAKED_ARTIFACT_TARGETS.includes(target);
        });

      expect(offenders).toEqual([]);
    });
  }

  it('the guardian still gets its own nested runtime mounts (not over an artifact path)', () => {
    // Guards against "fix" the lazy way — deleting the guardian's real mounts
    // to satisfy the assertion above. These targets are nested UNDER
    // /opt/openpalm but are not baked artifact paths, and must survive.
    const portals = read('packages/skeleton/system/stack/portals.compose.yml');
    expect(portals).toContain(':/opt/openpalm/guardian\n');
    expect(portals).toContain(':/opt/openpalm/logs\n');
  });
});
