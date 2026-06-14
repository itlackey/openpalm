import { describe, expect, test } from 'vitest';
import config from './ux-audit.wizard.config.json';

describe('wizard UX audit coverage (#457)', () => {
  test('captures every deep wizard step needed by the gate', () => {
    const stateIds = config.states.map((state) => state.id);
    expect(stateIds).toEqual([
      'wizard-0-system-check',
      'wizard-1-models',
      'wizard-1-models-empty-install',
      'wizard-2-extras',
      'wizard-3-review',
      'wizard-3-review-password-saved',
    ]);
  });

  test('writes review evidence to the wizard gate directory', () => {
    expect(config.outDir).toBe('../../.reviews/ux-gate-wizard');
  });

  test('pins the real deep-step targets', () => {
    const waits = Object.fromEntries(config.states.map((state) => [state.id, state.waitFor]));

    expect(waits).toEqual({
      'wizard-0-system-check': '.step-content',
      'wizard-1-models': '[data-testid="step-models"]',
      'wizard-1-models-empty-install': '[data-testid="step-models"]',
      'wizard-2-extras': '[data-testid="step-extras"]',
      'wizard-3-review': '#review-summary',
      'wizard-3-review-password-saved': '#review-summary',
    });
  });
});
