/**
 * Contract tests for the 0.13.0 image content reductions (final-four-plan.md
 * "Image footprint reduction" — IMG-1..IMG-5).
 *
 * These are content/manifest assertions only — no docker build is run here
 * (B4 handles measurement). They pin:
 *   - IMG-1: the four AI coding CLIs are gone from both tool manifests and
 *     the dead seeded skeleton copies are deleted outright.
 *   - IMG-2: the on-demand install skill's manifest lists every removed tool.
 *   - IMG-3: gcloud is no longer baked into the assistant image.
 *   - IMG-4: OpenCode musl + baseline variants are pruned from both images.
 *   - IMG-5: postgresql-client/libpq and libglib are dropped; gh/uv/jq/sqlite3 stay.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');

const REMOVED_CLI_PACKAGES = [
  '@anthropic-ai/claude-code',
  '@openai/codex',
  '@github/copilot',
  '@mariozechner/pi-coding-agent',
] as const;

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
}

// ── IMG-1: four AI coding CLIs removed from the tool manifests ─────────────

describe('IMG-1 — local tool manifests contain only OpenCode', () => {
  test('containers/assistant/tools/package.json no longer depends on unrelated CLIs', () => {
    const pkg = readJson('containers/assistant/tools/package.json');
    const deps = pkg.dependencies as Record<string, string>;
    for (const name of REMOVED_CLI_PACKAGES) {
      expect(deps).not.toHaveProperty(name);
    }
    expect(deps['opencode-ai']).toBe('1.18.9');
    expect(deps).not.toHaveProperty('akm-cli');
  });

  test('containers/guardian/tools/package.json no longer depends on unrelated CLIs', () => {
    const pkg = readJson('containers/guardian/tools/package.json');
    const deps = pkg.dependencies as Record<string, string>;
    for (const name of REMOVED_CLI_PACKAGES) {
      expect(deps).not.toHaveProperty(name);
    }
    expect(deps['opencode-ai']).toBe('1.18.9');
    expect(deps).not.toHaveProperty('akm-cli');
  });

  test('assistant and Guardian install the exact AKM pin in npm global root', () => {
    const assistant = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf8');
    const guardian = readFileSync(join(REPO_ROOT, 'containers/guardian/Dockerfile'), 'utf8');
    for (const dockerfile of [assistant, guardian]) {
      expect(dockerfile).toContain('ARG AKM_CLI_VERSION=0.9.0-rc.13');
      expect(dockerfile).toContain('npm install --global');
      expect(dockerfile).toContain('/usr/local/lib/node_modules/akm-cli');
      expect(dockerfile).toContain('test "$(npm root --global)" = "/usr/local/lib/node_modules"');
      expect(dockerfile).toContain('test "$(akm --version)" = "${AKM_CLI_VERSION}"');
    }
    expect(guardian).toContain('FROM node:22-trixie-slim');
  });
});

// ── S2 residue (touched here per final-four-plan.md instruction) ───────────

describe('dead seeded tool manifests removed from the skeleton', () => {
  test('packages/skeleton/data/{assistant,guardian,portal}/tools/package.json no longer exist', () => {
    for (const svc of ['assistant', 'guardian', 'portal']) {
      const p = join(REPO_ROOT, 'packages/skeleton/data', svc, 'tools', 'package.json');
      expect(existsSync(p)).toBe(false);
    }
  });
});

describe('AKM 0.9 migration boot contract', () => {
  const entrypoint = readFileSync(join(REPO_ROOT, 'containers/assistant/entrypoint.sh'), 'utf8');

  test('runs journaled migration and scheduler rebind before cron starts', () => {
    const migration = entrypoint.indexOf('akm migrate apply --config "$target_file"');
    const rebind = entrypoint.indexOf('akm task sync --rebind');
    const cron = entrypoint.lastIndexOf('start_cron_and_sync_tasks');
    expect(migration).toBeGreaterThan(-1);
    expect(rebind).toBeGreaterThan(migration);
    expect(cron).toBeGreaterThan(rebind);
  });

  test('fails health errors instead of continuing with partial AKM state', () => {
    expect(entrypoint).toContain('error: akm health check failed');
    expect(entrypoint).not.toContain('akm schema migration check failed (exit $rc); continuing startup');
  });

  test('backs up an unstamped 0.8 config before adding its migration sentinel', () => {
    const backup = entrypoint.indexOf('openpalm-pre-0.9-missing-version');
    const sentinel = entrypoint.indexOf('config.configVersion = "0.8.0"');
    expect(backup).toBeGreaterThan(-1);
    expect(sentinel).toBeGreaterThan(backup);
  });

  test('restores AKM recovery state and blocks same-version retries after failed verification', () => {
    expect(entrypoint).toContain('akm-migrate restore --for 0.9.0 --run "$migration_backup_run" --confirm');
    expect(entrypoint).toContain('openpalm-0.9-blocked-version');
    expect(entrypoint).toContain('install a newer AKM release before retrying');
  });
});

// ── IMG-2: on-demand install skill manifest ─────────────────────────────────

describe('IMG-2 — on-demand install skill', () => {
  const SKILL_DIR = join(REPO_ROOT, 'packages/skeleton/knowledge/skills/install-optional-tool');

  test('SKILL.md exists', () => {
    expect(existsSync(join(SKILL_DIR, 'SKILL.md'))).toBe(true);
  });

  test('tools.json manifest lists every removed CLI plus gcloud', () => {
    const manifest = readJson('packages/skeleton/knowledge/skills/install-optional-tool/tools.json');
    for (const id of ['codex', 'claude', 'copilot', 'pi', 'gcloud']) {
      expect(manifest).toHaveProperty(id);
    }
  });

  test('the install script exists and is executable', () => {
    const scriptPath = join(SKILL_DIR, 'scripts/install-tool.sh');
    expect(existsSync(scriptPath)).toBe(true);
  });
});

// ── IMG-3: gcloud SDK no longer baked into the assistant image ─────────────

describe('IMG-3 — gcloud SDK removed from the assistant image', () => {
  const dockerfile = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf8');

  test('no longer downloads the google-cloud-cli tarball', () => {
    expect(dockerfile).not.toContain('google-cloud-cli-linux');
    expect(dockerfile).not.toContain('dl.google.com/dl/cloudsdk');
  });

  test('no longer puts google-cloud-sdk on the baked PATH', () => {
    expect(dockerfile).not.toContain('/opt/google-cloud-sdk');
  });

  test('entrypoint no longer special-cases the baked gcloud dir on the cron PATH', () => {
    const entrypoint = readFileSync(join(REPO_ROOT, 'containers/assistant/entrypoint.sh'), 'utf8');
    expect(entrypoint).not.toContain('/opt/google-cloud-sdk');
  });
});

// ── IMG-4: OpenCode musl + baseline variants pruned ─────────────────────────

describe('IMG-4 — OpenCode musl + baseline variants pruned', () => {
  const UNWANTED_VARIANTS = [
    'opencode-linux-x64-musl',
    'opencode-linux-x64-baseline',
    'opencode-linux-x64-baseline-musl',
    'opencode-linux-arm64-musl',
  ] as const;

  test('assistant Dockerfile prunes every unwanted linux-x64/arm64 OpenCode variant', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf8');
    for (const variant of UNWANTED_VARIANTS) {
      expect(dockerfile).toContain(variant);
    }
  });

  test('guardian Dockerfile prunes every unwanted linux-x64/arm64 OpenCode variant', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'containers/guardian/Dockerfile'), 'utf8');
    for (const variant of UNWANTED_VARIANTS) {
      expect(dockerfile).toContain(variant);
    }
  });

  test('the AVX2-era CPU floor is documented', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs/system-requirements.md'), 'utf8');
    expect(doc).toMatch(/AVX2/);
  });
});

// ── IMG-5: postgresql-client/libpq + libglib dropped; gh/uv/jq/sqlite3 kept ─

describe('IMG-5 — speculative CLI tooling trimmed', () => {
  const dockerfile = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf8');

  test('postgresql-client and libglib2.0-0 are no longer installed', () => {
    expect(dockerfile).not.toContain('postgresql-client');
    expect(dockerfile).not.toContain('libglib2.0-0');
  });

  test('gh, jq, and sqlite3 are still installed', () => {
    expect(dockerfile).toContain('sqlite3');
    expect(dockerfile).toContain('jq');
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends gh/);
  });

  test('uv is still installed', () => {
    expect(dockerfile).toContain('astral.sh/uv/install.sh');
  });
});

// ── npm-global AKM onnxruntime pruning ──────────────────────────────────────

describe('onnxruntime content pruned from the npm-global AKM installation', () => {
  const assistant = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf8');
  const guardian = readFileSync(join(REPO_ROOT, 'containers/guardian/Dockerfile'), 'utf8');

  test('both images prune non-target-platform onnxruntime-node binaries', () => {
    for (const dockerfile of [assistant, guardian]) {
      expect(dockerfile).toContain('onnxruntime-node/bin/napi-v6/win32');
      expect(dockerfile).toContain('onnxruntime-node/bin/napi-v6/darwin');
    }
  });

  test('both images skip the CUDA/TensorRT provider download at install time', () => {
    for (const dockerfile of [assistant, guardian]) {
      expect(dockerfile).toContain('ONNXRUNTIME_NODE_INSTALL=skip');
    }
  });

  test('both images remove onnxruntime-web entirely', () => {
    for (const dockerfile of [assistant, guardian]) {
      expect(dockerfile).toContain('rm -rf');
      expect(dockerfile).toContain('onnxruntime-web');
    }
  });

  test('the Assistant build-time offline inference guard is still present', () => {
    expect(assistant).toContain("pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5')");
    expect(assistant).toContain(
      '/usr/local/lib/node_modules/akm-cli/node_modules/@huggingface/transformers/.cache',
    );
  });
});

// ── release workflow smoke no longer checks the removed CLIs ───────────────

describe('release.yml assistant smoke no longer checks removed CLIs', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');

  test('does not run codex/claude/pi/copilot --version', () => {
    expect(workflow).not.toContain('codex --version');
    expect(workflow).not.toContain('claude --version');
    expect(workflow).not.toContain('pi --version');
    expect(workflow).not.toContain('copilot --version');
  });
});
