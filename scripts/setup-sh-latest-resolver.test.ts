import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Structural test for A2 (docs/public-seams-review.md): setup.sh's "main"
// (latest) version resolver. setup.sh is a bash script with no test harness
// of its own, so this test extracts the *actual* extraction pipeline and
// normalize_version() function bodies out of the shipped file and runs them
// for real via bash — no fabricated stand-in copy that could silently drift
// from what actually ships.

const SETUP_SH_PATH = join(import.meta.dir, 'setup.sh');
const setupShSource = readFileSync(SETUP_SH_PATH, 'utf8');

function runBash(script: string, arg: string): string {
  const result = Bun.spawnSync({
    cmd: ['bash', '-c', script, 'bash', arg],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.stdout.toString('utf8');
}

describe('setup.sh "latest" resolver — releases-API extraction pipeline', () => {
  it('no longer scrapes the redirect Location header (regression guard for the brittle old resolver)', () => {
    expect(setupShSource).not.toMatch(/curl -sI/);
    expect(setupShSource).not.toMatch(/grep -i '\^location:'/);
  });

  it('queries the releases API with a fail-closed curl (-f)', () => {
    expect(setupShSource).toMatch(
      /curl -fsSL "https:\/\/api\.github\.com\/repos\/itlackey\/openpalm\/releases\/latest"/,
    );
  });

  it('guards the extracted tag with the existing die-on-empty fail-closed pattern', () => {
    expect(setupShSource).toMatch(/\[ -n "\$\{RAW_VERSION\}" \] \|\| die/);
  });

  it('pipes the raw tag through the existing normalize_version helper', () => {
    expect(setupShSource).toMatch(/VERSION="\$\(normalize_version "\$\{RAW_VERSION\}"\)"/);
  });

  // Extract the exact grep|sed pipeline used against the releases-API JSON body,
  // so this test runs the real, shipped extraction logic rather than a copy.
  const pipelineMatch = setupShSource.match(
    /grep '"tag_name"' \| sed -E '[^']+'/,
  );
  if (!pipelineMatch) {
    throw new Error('Could not locate the tag_name extraction pipeline in scripts/setup.sh');
  }
  const pipeline = pipelineMatch[0];

  function extractTag(sampleJson: string): string {
    return runBash(`printf '%s\\n' "$1" | ${pipeline}`, sampleJson).trim();
  }

  it('extracts a bare-semver prerelease tag from a realistic releases/latest body', () => {
    const sample = JSON.stringify({
      url: 'https://api.github.com/repos/itlackey/openpalm/releases/12345',
      tag_name: '0.13.0-beta.13',
      name: '0.13.0-beta.13',
      draft: false,
      prerelease: true,
    });
    expect(extractTag(sample)).toBe('0.13.0-beta.13');
  });

  it('extracts a plain release tag with no prerelease suffix', () => {
    const sample = '{"tag_name":"0.12.0","name":"0.12.0","draft":false,"prerelease":false}';
    expect(extractTag(sample)).toBe('0.12.0');
  });

  it('extracts a legacy v-prefixed tag verbatim (normalize_version strips it downstream)', () => {
    const sample = '{\n  "tag_name": "v0.11.0",\n  "draft": false\n}';
    expect(extractTag(sample)).toBe('v0.11.0');
  });

  it('tolerates no space after the colon (compact JSON)', () => {
    const sample = '{"tag_name":"0.13.0-rc.2"}';
    expect(extractTag(sample)).toBe('0.13.0-rc.2');
  });

  it('yields an empty string when tag_name is absent — the die-on-empty guard then fails closed', () => {
    const sample = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}';
    expect(extractTag(sample)).toBe('');
  });
});

describe('setup.sh normalize_version() — extracted and executed from the real file', () => {
  const fnMatch = setupShSource.match(/normalize_version\(\) \{[\s\S]*?\n\}/);
  if (!fnMatch) {
    throw new Error('Could not locate normalize_version() in scripts/setup.sh');
  }
  const normalizeVersionFn = fnMatch[0];

  function normalizeVersion(input: string): string {
    return runBash(`${normalizeVersionFn}\nnormalize_version "$1"`, input).trim();
  }

  it('strips a leading v from a legacy-tagged version', () => {
    expect(normalizeVersion('v0.11.0')).toBe('0.11.0');
  });

  it('leaves a bare-semver version untouched', () => {
    expect(normalizeVersion('0.13.0-beta.13')).toBe('0.13.0-beta.13');
  });

  it('composes with the extraction pipeline end-to-end', () => {
    const pipelineMatch = setupShSource.match(/grep '"tag_name"' \| sed -E '[^']+'/);
    if (!pipelineMatch) throw new Error('pipeline not found');
    const rawTag = runBash(
      `printf '%s\\n' "$1" | ${pipelineMatch[0]}`,
      '{"tag_name":"v0.12.5"}',
    ).trim();
    expect(normalizeVersion(rawTag)).toBe('0.12.5');
  });
});
