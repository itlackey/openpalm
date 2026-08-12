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
  // bake. The default path has no installer call at all.
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

describe('the assistant crontab shim does not need root', () => {
  // busybox's `crontab` applet checks that it is root (or suid) BEFORE it
  // honours `-c <spooldir>`, and the assistant runs as an unprivileged uid. A
  // shim that shelled out to it therefore failed on every invocation with
  // "crontab: must be suid to work properly" — and because both call sites
  // wrote `2>/dev/null || true`, boot looked clean while the spool dir stayed
  // empty and NOTHING was ever scheduled. It surfaced only as akm's task-sync
  // loop failing every 60s, forever.
  it('writes the spool file directly instead of invoking the root-only applet', () => {
    // NOT codeLines(): it strips from the first `#`, and the offending line
    // built the shim with `printf '#!/usr/bin/env sh\nexec busybox crontab …'`
    // — the shebang inside the string hid the rest of the line from it. Drop
    // whole-line shell comments only, so prose stays exempt but code does not.
    const offenders = read('containers/assistant/entrypoint.sh')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && /busybox\s+crontab/.test(l));
    expect(offenders).toEqual([]);
  });

  it('does not silence the crontab install', () => {
    const offenders = codeLines(read('containers/assistant/entrypoint.sh')).filter((l) =>
      /^\s*crontab\b.*2>\/dev\/null\s*\|\|\s*true/.test(l),
    );
    expect(offenders).toEqual([]);
  });
});

describe('official images assemble platform code locally', () => {
  it('does not resolve public OpenPalm packages in the Assistant image', () => {
    const dockerfile = read('containers/assistant/Dockerfile');
    expect(dockerfile).toContain('COPY packages/ui /opt/openpalm/local-src/packages/ui');
    expect(dockerfile).toContain('bun pm pack');
    expect(dockerfile).not.toContain('@openpalm/ui@${PLATFORM_VERSION}');
    expect(dockerfile).not.toContain('/opt/openpalm/skeleton');
  });

  it('does not resolve public OpenPalm packages in the Guardian image', () => {
    const dockerfile = read('containers/guardian/Dockerfile');
    expect(dockerfile).toContain('COPY packages/guardian /opt/openpalm/local-src/guardian');
    expect(dockerfile).toContain('openpalm-guardian-*.tgz');
    expect(dockerfile).not.toContain('/opt/openpalm/skeleton');
  });

  it('assembles portal candidates from local workspaces', () => {
    const dockerfile = read('containers/portal/Dockerfile');
    expect(dockerfile).toContain('COPY packages/portal-sdk');
    expect(dockerfile).toContain('COPY packages/portal-discord');
    expect(dockerfile).toContain('COPY packages/portal-slack');
    expect(dockerfile).not.toContain('containers/portal/tools/package.json');
  });
});

describe('nothing is mounted over the image-baked artifact paths', () => {
  // Everything the images bake and serve from. A bind or volume landing on any
  // of these hides the image's own copy — the #585 stale-artifact bug.
  const BAKED_ARTIFACT_TARGETS = [
    '/opt/openpalm',
    '/opt/openpalm/tools',
    '/opt/openpalm/ui',
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
