/**
 * SystemCheckStep — auto-advance vs blocking-conflict gate (W3).
 *
 * `runChecks()` used to auto-advance on `docker.ok && compose.ok` alone,
 * ignoring `hasBlockingConflict` entirely — a user with another app parked on
 * a required port (or, now, a hard disk-space block) never saw this screen's
 * own Retry button; they sailed straight through to an opaque failure later.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SystemCheckStep from './SystemCheckStep.svelte';
import { setupState } from '$lib/setup/setup-state.svelte.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

const BASE_OK = {
  ok: true,
  docker: { ok: true, version: '27.0.1' },
  compose: { ok: true, version: 'v2.29.1' },
  portCheckReliable: true,
  ports: [] as Array<{ port: number; service: string; available: boolean; blocking: boolean }>,
  platform: 'linux',
  disk: { status: 'ok' as const, message: null, blocking: false },
};

afterEach(() => {
  setupState.reset();
  vi.unstubAllGlobals();
});

describe('SystemCheckStep — auto-advance respects blocking conflicts', () => {
  test('docker+compose ok with no blocking conflict auto-advances', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(BASE_OK)));

    render(SystemCheckStep);

    await vi.waitFor(() => expect(setupState.systemCheckPassed).toBe(true));
    expect(setupState.currentStep).toBe(1);
  });

  test('a blocking port conflict is NOT auto-advanced past', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...BASE_OK,
      ports: [{ port: 3800, service: 'ui', available: false, blocking: true }],
    })));

    render(SystemCheckStep);

    await expect.element(page.getByText(/Port conflict on 3800/i)).toBeVisible();
    // Give any (incorrect) auto-advance a chance to have fired before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(setupState.systemCheckPassed).toBe(false);
    expect(setupState.currentStep).toBe(0);
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  test('a non-blocking port conflict still auto-advances', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...BASE_OK,
      portCheckReliable: false,
      ports: [{ port: 3800, service: 'ui', available: false, blocking: false }],
    })));

    render(SystemCheckStep);

    await vi.waitFor(() => expect(setupState.systemCheckPassed).toBe(true));
  });

  test('a blocking disk-space reading (W11) also prevents auto-advance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...BASE_OK,
      disk: { status: 'critical', message: 'Critically low disk space on /fake: 0.5 GB free.', blocking: true },
    })));

    render(SystemCheckStep);

    await expect.element(page.getByText('0.5 GB free')).toBeVisible();
    await new Promise((r) => setTimeout(r, 0));
    expect(setupState.systemCheckPassed).toBe(false);
  });

  test('a non-blocking (warning-only) disk reading does not prevent auto-advance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...BASE_OK,
      disk: { status: 'low', message: 'Low disk space on /fake: 3 GB free.', blocking: false },
    })));

    render(SystemCheckStep);

    await expect.element(page.getByText('3 GB free')).toBeVisible();
    await vi.waitFor(() => expect(setupState.systemCheckPassed).toBe(true));
  });
});
