import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');
const onboardingSource = readFileSync(
  fileURLToPath(new URL('../(app)/connections/new/+page.svelte', import.meta.url)),
  'utf8',
);

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

  // The install-or-connect question lives on the onboarding surface its answer
  // leads to, so that page offers the local install and the wizard offers the
  // way back out. There is no separate welcome route to return to any more —
  // and the escape had to become durable, because a machine without Docker
  // cannot finish this wizard and a reload used to drag it straight back in.
  test('the onboarding surface offers local setup, and the wizard offers the way out', () => {
    expect(onboardingSource).toMatch(/Set up OpenPalm on this computer/);
    expect(onboardingSource).toMatch(/routes\?\.setup/);
    expect(source).toContain("resolve('/connections/new?onboarding=1')");
    expect(source).not.toContain("resolve('/start')");
  });
});
