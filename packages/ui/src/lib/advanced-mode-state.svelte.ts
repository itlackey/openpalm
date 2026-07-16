export const ADVANCED_MODE_STORAGE_KEY = 'openpalm.chat.advanced';

class AdvancedModeService {
  enabled = $state(false);
  initialized = $state(false);

  init(): void {
    if (typeof window === 'undefined' || this.initialized) return;
    this.enabled = this.#readStoredPreference();
    this.initialized = true;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    this.#writeStoredPreference(value);
  }

  toggle(): boolean {
    const next = !this.enabled;
    this.setEnabled(next);
    return next;
  }

  #readStoredPreference(): boolean {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(ADVANCED_MODE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  #writeStoredPreference(value: boolean): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, value ? '1' : '0');
    } catch {
      // Ignore storage failures; in-memory state still applies.
    }
  }
}

export const advancedModeService = new AdvancedModeService();
