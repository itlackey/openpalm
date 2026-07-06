/**
 * P5b (#555) RED — client landing choice (P5b item 3, plan §6.5 pwa-static
 * branch).
 *
 * The client app has no host capabilities, no LaunchState, no migration
 * gate — its resolver is the §6.5 client branch only, keyed off the stored
 * connection list:
 *
 *     0 connections  -> '/connections/new'
 *     >=1 connection -> '/chat'
 *
 * Pure and synchronous: the boot code awaits the store's list() and hands
 * the array in; the resolver itself does no I/O (same discipline as
 * packages/ui/src/lib/resolve-landing.ts — resolution is data-in,
 * path-out).
 *
 * RED until src/lib/resolve-landing.ts exists: every test fails with
 * "Cannot find module …/src/lib/resolve-landing.ts" (missing feature).
 */
import { describe, expect, test } from 'bun:test';
import { loadLandingModule } from './helpers/contract.ts';

describe('client landing choice (P5b item 3)', () => {
  test('no stored connections lands on /connections/new', async () => {
    const { resolveLanding } = await loadLandingModule();
    expect(resolveLanding([])).toBe('/connections/new');
  });

  test('one stored connection lands on /chat', async () => {
    const { resolveLanding } = await loadLandingModule();
    expect(resolveLanding([{ id: 'conn-1' }])).toBe('/chat');
  });

  test('multiple stored connections still land on /chat', async () => {
    const { resolveLanding } = await loadLandingModule();
    expect(resolveLanding([{ id: 'conn-1' }, { id: 'conn-2' }, { id: 'conn-3' }])).toBe('/chat');
  });
});
