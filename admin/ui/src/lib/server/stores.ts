/** Lazy singleton store instances, initialized on first access. */

import { SetupManager } from './setup.js';
import { AutomationStore } from './automation-store.js';
import { ProviderStore } from './provider-store.js';
import { DATA_DIR, CRON_DIR } from './env.js';

let _setup: SetupManager | undefined;
let _automations: AutomationStore | undefined;
let _providers: ProviderStore | undefined;

export function getSetupManager(): SetupManager {
  if (!_setup) _setup = new SetupManager(DATA_DIR);
  return _setup;
}

export function getAutomationStore(): AutomationStore {
  if (!_automations) _automations = new AutomationStore(DATA_DIR, CRON_DIR);
  return _automations;
}

export function getProviderStore(): ProviderStore {
  if (!_providers) _providers = new ProviderStore(DATA_DIR);
  return _providers;
}
