import { describe, expect, it } from 'bun:test';
import { DEFAULT_UI_PORT, resolveHostUiPortFromEnv } from './ports.ts';

// U2: ui-server.ts's resolveUiServePort and client-server.ts's
// resolveHostUiPort byte-duplicated this merge-and-resolve logic
// (`{ ...persistedEnv, ...env }; Number(merged.OP_HOST_UI_PORT) || DEFAULT_UI_PORT`).
// The stated "import cycle" justification for the duplication didn't hold —
// both files already import ports.ts, which imports neither of them — so the
// shared resolver is hoisted here and imported by both instead.
describe('resolveHostUiPortFromEnv (U2: shared OP_HOST_UI_PORT resolver)', () => {
  it('uses OP_HOST_UI_PORT from the persisted-env record when the live env has none', () => {
    expect(resolveHostUiPortFromEnv({}, { OP_HOST_UI_PORT: '9200' })).toBe(9200);
  });

  it('lets the live env override the persisted value', () => {
    expect(resolveHostUiPortFromEnv({ OP_HOST_UI_PORT: '9300' } as NodeJS.ProcessEnv, { OP_HOST_UI_PORT: '9200' })).toBe(9300);
  });

  it('falls back to DEFAULT_UI_PORT when nothing is set', () => {
    expect(resolveHostUiPortFromEnv({}, {})).toBe(DEFAULT_UI_PORT);
    expect(DEFAULT_UI_PORT).toBe(3880);
  });
});
