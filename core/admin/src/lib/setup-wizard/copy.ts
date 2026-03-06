// Mapping notes:
// - Welcome/overall framing aligns to deck "Screen 1 — Welcome"
// - Connection step prompt aligns to deck "Screen 3 — Add connection: type"
// - Model selection framing aligns to deck "Screen 5 — Required models"
export const SETUP_WIZARD_COPY = {
  wizardHeaderTitle: 'OpenPalm Setup Wizard',
  wizardHeaderSubtitle: 'Configure your OpenPalm stack in a few steps.',
  connectionTypePrompt: 'How do you want to connect to an LLM?',
  selectModelsTitle: 'Select Models',
  selectModelsDescription: 'Choose which models to use for each role.',
} as const;
