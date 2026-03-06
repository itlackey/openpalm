import {
  WIZARD_CANONICAL_COPY_SOURCE,
  WIZARD_SCOPE_DECISION_BLOCK,
} from './scope.js';

// Mapping notes:
// - Welcome/overall framing aligns to deck "Screen 1 — Welcome"
// - Connection step prompt aligns to deck "Screen 3 — Add connection: type"
// - Model selection framing aligns to deck "Screen 5 — Required models"
export const SETUP_WIZARD_COPY = {
  canonicalSourcePath: WIZARD_CANONICAL_COPY_SOURCE,
  scopeDecisionBlock: WIZARD_SCOPE_DECISION_BLOCK,
  wizardHeaderTitle: 'OpenPalm Setup Wizard',
  wizardHeaderSubtitle: 'Configure your OpenPalm stack in a few steps.',
  connectionTypePrompt: 'How do you want to connect to an LLM?',
  selectModelsTitle: 'Select Models',
  selectModelsDescription: 'Choose which models to use for each role.',
} as const;
