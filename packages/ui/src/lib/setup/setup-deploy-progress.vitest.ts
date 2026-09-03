/**
 * #678 — the install phase sequence and its terminal states.
 *
 * Filed as manual acceptance work ("watch the install progress through
 * writing-config → pulling-images → starting → ready"). It is not manual: the
 * whole sequence is `pollDeployStatus` reading a journal, so it belongs here,
 * in the lane that runs on every CI run, rather than in a tier-5 gate that has
 * to be invoked — the milestone's own finding was that a gate which never runs
 * is not a gate, and that lane produced three checked boxes across three
 * releases.
 *
 * These also pin the two ways the screen can hang forever, which is the actual
 * risk this check exists for: polling that never terminates, and a terminal
 * state that never renders.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SetupState } from './setup-state.svelte.js';

vi.mock('$lib/setup-api.js', () => ({
  fetchVoiceProfiles: vi.fn(async () => null),
  fetchOllamaProfiles: vi.fn(async () => null),
  fetchRecommendation: vi.fn(async () => null),
  ensureOpenCode: vi.fn(async () => null),
  fetchOpenCodeStatus: vi.fn(async () => null),
  fetchOpenCodeProviders: vi.fn(async () => null),
  fetchDetectedProviders: vi.fn(async () => null),
  fetchProviderModels: vi.fn(async () => ({ models: [] })),
  authorizeOpenCodeOAuth: vi.fn(async () => ({ source: 'wizard' })),
  pollOpenCodeOAuthCallback: vi.fn(async () => ({ ok: false, data: null })),
  completeSetup: vi.fn(async () => ({ ok: true, data: { ok: true } })),
  fetchDeployStatus: vi.fn(async () => ({ ok: false, data: null })),
  retryDeploy: vi.fn(async () => ({ ok: true, data: { ok: true } })),
  fetchHostStatus: vi.fn(async () => null),
  importHost: vi.fn(async () => ({ ok: true, data: { ok: true } })),
  fetchCurrentConfig: vi.fn(async () => null),
  fetchSetupStatus: vi.fn(async () => ({ setupComplete: false })),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Queue one deploy-status response per poll, in order. */
async function queuePolls(responses: unknown[]): Promise<void> {
  const api = await import('$lib/setup-api.js');
  const mock = vi.mocked(api.fetchDeployStatus);
  mock.mockReset();
  for (const data of responses) mock.mockImplementationOnce(async () => ({ ok: true, data }) as never);
  // Anything after the queue repeats the last response rather than falling
  // back to `ok: false`, which would trip the lost-contact path instead.
  mock.mockImplementation(async () => ({ ok: true, data: responses[responses.length - 1] }) as never);
}

describe('#678 install phase sequence', () => {
  it('walks writing-config → pulling-images → starting → ready and stops when everything is running', async () => {
    vi.useFakeTimers();
    await queuePolls([
      { deploying: true, setupComplete: false, phase: 'writing-config', deployStatus: [] },
      { deploying: true, setupComplete: false, phase: 'pulling-images', deployStatus: [{ service: 'assistant', status: 'pending' }] },
      { deploying: true, setupComplete: false, phase: 'starting', deployStatus: [{ service: 'assistant', status: 'pending' }] },
      { deploying: false, setupComplete: true, phase: 'ready', deployStatus: [{ service: 'assistant', status: 'running' }] },
    ]);

    const s = new SetupState();
    const seen: string[] = [];
    s.startDeployPolling();

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 2500);
      seen.push(String(s.deployData.phase));
    }

    expect(seen).toEqual(['writing-config', 'pulling-images', 'starting', 'ready']);
    expect(s.deployDone).toBe(true);
    expect(s.deployHasWarnings).toBe(false);
    expect(s.deployError).toBeNull();
    s.dispose();
  });

  // The hang this check exists to catch: an optional service that failed is
  // never going to reach `running`, so a poller that waits for all-running
  // waits forever and the operator sits on a spinner with a finished stack.
  it('terminates with a warning when only optional services failed, instead of polling forever', async () => {
    vi.useFakeTimers();
    await queuePolls([
      {
        deploying: false,
        setupComplete: true,
        phase: 'ready',
        deployStatus: [
          { service: 'assistant', status: 'running' },
          { service: 'voice', status: 'warning' },
        ],
      },
    ]);

    const s = new SetupState();
    s.startDeployPolling();
    await vi.advanceTimersByTimeAsync(0);

    expect(s.deployDone).toBe(true);
    expect(s.deployHasWarnings).toBe(true);
    expect(s.deployError).toBeNull();

    // Terminal really means terminal: no further polls are scheduled.
    const api = await import('$lib/setup-api.js');
    const callsAtTerminal = vi.mocked(api.fetchDeployStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(api.fetchDeployStatus).mock.calls.length).toBe(callsAtTerminal);
    s.dispose();
  });

  // The mirror image: a service still coming up is NOT a terminal state, and
  // treating a warning row as one too early would declare the install finished
  // while something was still starting.
  it('keeps polling while a non-warning service is still pending', async () => {
    vi.useFakeTimers();
    await queuePolls([
      {
        deploying: false,
        setupComplete: true,
        phase: 'starting',
        deployStatus: [
          { service: 'assistant', status: 'pending' },
          { service: 'voice', status: 'warning' },
        ],
      },
    ]);

    const s = new SetupState();
    s.startDeployPolling();
    await vi.advanceTimersByTimeAsync(0);

    expect(s.deployDone).toBe(false);
    expect(s.deployHasWarnings).toBe(false);

    const api = await import('$lib/setup-api.js');
    const before = vi.mocked(api.fetchDeployStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2500);
    expect(vi.mocked(api.fetchDeployStatus).mock.calls.length).toBeGreaterThan(before);
    s.dispose();
  });

  it('a deploy error stops polling and surfaces the message', async () => {
    vi.useFakeTimers();
    await queuePolls([
      { deploying: false, setupComplete: false, phase: 'starting', deployError: 'pull failed: manifest unknown' },
    ]);

    const s = new SetupState();
    s.startDeployPolling();
    await vi.advanceTimersByTimeAsync(0);

    expect(s.deployError).toBe('pull failed: manifest unknown');
    expect(s.deployDone).toBe(false);

    const api = await import('$lib/setup-api.js');
    const callsAtError = vi.mocked(api.fetchDeployStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(api.fetchDeployStatus).mock.calls.length).toBe(callsAtError);
    s.dispose();
  });
});
