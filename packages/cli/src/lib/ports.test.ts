import { describe, expect, it } from 'bun:test';
import { DEFAULT_ASSISTANT_PORT, DEFAULT_UI_PORT } from './ports.ts';
import { DEFAULT_HOST_UI_PORT, STACK_DEFAULTS } from '@openpalm/lib';

// U2 originally lived here as `resolveHostUiPortFromEnv`, a CLI-local wrapper
// around lib's resolver that pinned `explicit` to undefined — which forced
// resolveUiServePort to re-implement the "an explicit --port wins" half itself,
// putting one two-parameter precedence rule in two places. resolveUiServePort
// now calls lib's resolveHostUiPort directly, so the precedence is tested once,
// in network-contract.test.ts, and the wrapper is gone.
//
// What ports.ts still owns is the CLI's import site for the shared constants.
// The literals are asserted here because three independent `3880`s (and the
// inline `?? 3880` fallbacks beside them) are how the desktop app came to bind a
// different port than `openpalm` on the same home — if this module ever stops
// deferring to lib, that must fail loudly rather than diverge quietly.
describe('CLI port constants defer to the shared table', () => {
  it('re-exports the ONE host-UI default, not a second literal', () => {
    expect(DEFAULT_UI_PORT).toBe(DEFAULT_HOST_UI_PORT);
    expect(DEFAULT_UI_PORT).toBe(3880);
  });

  it('re-exports the assistant default from the canonical port table', () => {
    expect(DEFAULT_ASSISTANT_PORT).toBe(STACK_DEFAULTS.ports.assistant);
  });
});
