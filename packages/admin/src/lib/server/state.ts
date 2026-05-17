/**
 * Singleton control plane state — shared across all SvelteKit server routes.
 *
 * Initialized once on server start. All API endpoints operate on this
 * shared state instance.
 */
import { createState, type ControlPlaneState } from "@openpalm/lib";

let _state: ControlPlaneState | null = null;

export function getState(): ControlPlaneState {
  if (!_state) {
    _state = createState();
  }
  return _state;
}

/**
 * Bust the singleton so the next getState() call re-reads from disk.
 * Called after performSetup() writes new tokens to stack.env.
 */
export function resetState(): void {
  _state = null;
}

/**
 * Replace the singleton state. Exposed for test-helpers only — do not
 * call from production code.
 */
export function _replaceState(s: ControlPlaneState): void {
  _state = s;
}
