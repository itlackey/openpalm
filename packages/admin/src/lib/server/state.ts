/**
 * Singleton control plane state — shared across all SvelteKit server routes.
 *
 * Initialized once on server start. All API endpoints operate on this
 * shared state instance.
 */
import { createState, type ControlPlaneState } from "./control-plane.js";

let _state: ControlPlaneState | null = null;

export function getState(): ControlPlaneState {
  if (!_state) {
    _state = createState();
  }
  return _state;
}

/** Reset state (used in tests) */
export function resetState(token?: string): ControlPlaneState {
  _state = createState(token);
  return _state;
}
