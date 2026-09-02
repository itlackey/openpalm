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
  // No exceptions any more. The guardian used to carve one out for
  // install_artifact + OP_GUARDIAN_NPM_VERSION, and that override is exactly
  // how a stale env key silently downgraded a correct image and broke every
  // stack update for months. Every entrypoint now runs what the image baked.
  const cases: Array<{ file: string; allowInstallArtifact: boolean }> = [
    { file: 'containers/assistant/entrypoint.sh', allowInstallArtifact: false },
    { file: 'containers/portal/start.sh', allowInstallArtifact: false },
    { file: 'containers/guardian/entrypoint.sh', allowInstallArtifact: false },
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

describe('assistant task scheduling works unprivileged', () => {
  // Everything here is one bug with three layers, all of which shipped silent.
  // busybox cannot schedule anything in this image: `crontab` checks for root
  // BEFORE honouring -c, and `crond` both refuses crontabs not owned by uid 0
  // (skipping them with no log line) and calls setgroups/setgid/setuid in the
  // job child, which fail for an unprivileged user. The assistant runs as uid
  // 1000, so tasks were written and never ran. supercronic replaces it.
  const entrypointCode = () =>
    // NOT codeLines(): it strips from the first `#`, and the original offender
    // built the shim with `printf '#!/usr/bin/env sh\nexec busybox crontab …'`
    // — the shebang inside the string hid the rest of the line from it. Drop
    // whole-line shell comments only, so prose stays exempt but code does not.
    read('containers/assistant/entrypoint.sh')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l));

  it('never invokes busybox for cron', () => {
    expect(entrypointCode().filter((l) => /busybox\s+cron(tab|d)/.test(l))).toEqual([]);
  });

  // supercronic exits fatal on `export NAME="value"` — that is shell syntax,
  // not crontab env-assignment syntax. busybox crond silently ignored those
  // lines, so jobs never received this env under either scheduler.
  it('writes crontab env assignments, not shell exports', () => {
    const offenders = entrypointCode().filter((l) => /^\s*echo\s+"export /.test(l));
    expect(offenders).toEqual([]);
  });

  // Pinned by sha256 for every arch the release workflow builds, because
  // upstream publishes no checksum file alongside the release binaries.
  it('pins supercronic by version and per-arch sha256', () => {
    const dockerfile = read('containers/assistant/Dockerfile');
    expect(dockerfile).toMatch(/ARG SUPERCRONIC_VERSION=v\d+\.\d+\.\d+/);
    expect(dockerfile).toMatch(/sha256sum -c -/);
    for (const arch of ['amd64', 'arm64']) {
      expect(dockerfile).toMatch(new RegExp(`${arch}\\) supercronic_sha=[0-9a-f]{64}`));
    }
  });

  it('does not silence the crontab install', () => {
    const offenders = codeLines(read('containers/assistant/entrypoint.sh')).filter((l) =>
      /^\s*crontab\b.*2>\/dev\/null\s*\|\|\s*true/.test(l),
    );
    expect(offenders).toEqual([]);
  });

  // akm refuses to write scheduler entries from a "package-local" invocation
  // unless --rebind is passed: it only trusts an npm-global or standalone
  // install, because a package-local one is normally mutable. Ours is baked
  // into the image (E2/S2 above — no runtime installs, nothing mounted over
  // the artifact paths), so that concern does not apply and --rebind is the
  // correct binding. The migration path already passed it; the two sync call
  // sites did not, so every task silently failed to install. Keep them aligned.
  it('every akm task sync passes --rebind', () => {
    // Anchor on the invocation helper, not the bare phrase: the warning
    // strings next to these calls also contain "akm task sync".
    const offenders = codeLines(read('containers/assistant/entrypoint.sh')).filter(
      (l) => /run_akm_command\s+akm task sync\b/.test(l) && !/--rebind\b/.test(l),
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
          // second colon-separated field, once interpolations are out of the
          // way — the guarded `${OP_HOME:?}` sources carry a colon of their own.
          const target = line.replace(/^-\s*/, '').replace(/\$\{[^}]*\}/g, '').split(':')[1];
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
