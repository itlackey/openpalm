import { describe, expect, test } from 'vitest';
import config from './ux-audit.wizard.config.json';

describe('wizard UX audit coverage (#457)', () => {
  test('captures every deep wizard step needed by the gate', () => {
    const stateIds = config.states.map((state) => state.id);
    expect(stateIds).toEqual([
      'wizard-1-system-check',
      'wizard-2-get-started',
      'wizard-3-providers-recommended',
      'wizard-4-providers-manual',
      'wizard-5-models',
      'wizard-6-voice',
      'wizard-7-options',
      'wizard-8-review',
    ]);
  });

  test('writes review evidence to the wizard gate directory', () => {
    expect(config.outDir).toBe('../../.reviews/ux-gate-wizard');
  });

  test('pins the real deep-step targets', () => {
    const waits = Object.fromEntries(config.states.map((state) => [state.id, state.waitFor]));

    expect(waits).toEqual({
      'wizard-1-system-check': '.step-content',
      'wizard-2-get-started': '.step-content',
      'wizard-3-providers-recommended': '.step-content',
      'wizard-4-providers-manual': '.step-content',
      'wizard-5-models': '[data-testid="step-models"]',
      'wizard-6-voice': '[data-testid="step-voice"]',
      'wizard-7-options': '[data-testid="step-options"]',
      'wizard-8-review': '#review-summary',
    });
  });
});
