import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');
const startSource = readFileSync(fileURLToPath(new URL('../start/+page.svelte', import.meta.url)), 'utf8');

describe('setup prerequisite handoff', () => {
  test('renders the existing Docker system check visibly instead of hiding it', () => {
    const checkBlock = source.slice(
      source.indexOf('{#if s.currentStep === 0'),
      source.indexOf('{#if s.showDeploy}'),
    );
    expect(checkBlock).toContain('<SystemCheckStep />');
    expect(checkBlock).not.toContain('display:none');
    expect(checkBlock).not.toContain('aria-hidden="true"');
  });

  test('offers the remote-onboarding path from first-run local setup', () => {
    expect(source).toContain("resolve('/connections/new?onboarding=1')");
    expect(source).toMatch(/Connect to an existing OpenPalm/);
  });

  test('local setup entered from /start can explicitly return to /start', () => {
    expect(startSource).toContain("resolve('/setup?from=start')");
    expect(source).toContain("from '$app/state'");
    expect(source).toContain("resolve('/start')");
    expect(source).toMatch(/Back to (start|welcome)/i);
  });
});
