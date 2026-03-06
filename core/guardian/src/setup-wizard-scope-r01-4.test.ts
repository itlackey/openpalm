import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('R01-4 setup wizard copy usage', () => {
  it('setup page imports and uses SETUP_WIZARD_COPY for key moved strings', () => {
    const setupPage = readRepoFile('core/admin/src/routes/setup/+page.svelte');

    expect(setupPage).toContain("import { SETUP_WIZARD_COPY } from '$lib/setup-wizard/copy.js';");
    expect(setupPage).toContain('{SETUP_WIZARD_COPY.wizardHeaderTitle}');
    expect(setupPage).toContain('{SETUP_WIZARD_COPY.wizardHeaderSubtitle}');
    expect(setupPage).toContain('{SETUP_WIZARD_COPY.connectionTypePrompt}');
    expect(setupPage).toContain('{SETUP_WIZARD_COPY.selectModelsTitle}');
    expect(setupPage).toContain('{SETUP_WIZARD_COPY.selectModelsDescription}');

    expect(setupPage).not.toContain('OpenPalm Setup Wizard');
    expect(setupPage).not.toContain('Configure your OpenPalm stack in a few steps.');
    expect(setupPage).not.toContain('How do you want to connect to an LLM?');
    expect(setupPage).not.toContain('Choose which models to use for each role.');
  });
});

describe('R01-4 wizard scope docs validation command', () => {
  it('validate-wizard-scope-docs script exists and passes', () => {
    const scriptPath = resolve(REPO_ROOT, 'scripts/validate-wizard-scope-docs.mjs');
    const scriptContent = readFileSync(scriptPath, 'utf8');

    expect(scriptContent).toContain('Wizard scope docs validation passed.');

    const result = spawnSync('node', ['scripts/validate-wizard-scope-docs.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Wizard scope docs validation passed.');
  });
});

describe('R01-4 docs script wiring', () => {
  it('package.json includes docs:check:wizard-scope script', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts).toBeDefined();
    expect(packageJson.scripts?.['docs:check:wizard-scope']).toBe('node scripts/validate-wizard-scope-docs.mjs');
  });

  it('CONTRIBUTING.md mentions docs:check:wizard-scope usage', () => {
    const contributing = readRepoFile('docs/CONTRIBUTING.md');

    expect(contributing).toContain('bun run docs:check:wizard-scope');
    expect(contributing).toContain('Validate setup wizard scope docs stay aligned');
  });
});
