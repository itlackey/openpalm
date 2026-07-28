import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FOCUS_TRAP_TS = fileURLToPath(new URL('./actions/focus-trap.ts', import.meta.url));
const DRAWER_SVELTE = fileURLToPath(
  new URL('./components/common/Drawer.svelte', import.meta.url),
);

describe('shared focus-trap action', () => {
  test('exists as a UI-internal browser action', () => {
    expect(existsSync(FOCUS_TRAP_TS)).toBe(true);
  });

  test('exports the primitives used by Drawer', async () => {
    const mod = (await import(FOCUS_TRAP_TS)) as Record<string, unknown>;
    expect(typeof mod.createFocusTrap).toBe('function');
    expect(typeof mod.handleTrapKeydown).toBe('function');
  });

  test('Drawer imports the internal action', () => {
    const source = readFileSync(DRAWER_SVELTE, 'utf-8');
    expect(source).toMatch(/from\s+['"]\.\.\/\.\.\/actions\/focus-trap\.js['"]/);
  });
});
