/**
 * POST /api/setup/opencode/ensure
 *
 * Ensures an OpenCode server is running for the setup wizard.
 * 1. Checks the configured OP_OPENCODE_URL / OP_ASSISTANT_PORT first.
 * 2. If unreachable, starts a dedicated `opencode serve` subprocess via the SDK.
 * 3. Returns { ok, url, started }.
 *
 * The resolved URL is recorded in `$lib/server/opencode/wizard-instance.js`
 * (NOT written to `process.env.OP_OPENCODE_URL`, which stays untouched) so the
 * sibling `/api/setup/opencode/*` routes — providers, status, both OAuth
 * routes — can target this same instance via `resolveSetupOpencodeTarget()`
 * (`$lib/server/opencode/setup-target.js`) instead of each hardcoding the
 * deployed-assistant target, which is unreachable until the first deploy
 * completes (W1).
 *
 * No auth required — called during pre-setup wizard initialization.
 */
import { spawn } from 'node:child_process';
import { json } from '@sveltejs/kit';
import { getWizardOpencodeUrl, setWizardOpencodeUrl } from '$lib/server/opencode/wizard-instance.js';
import type { RequestHandler } from './$types';

// Module-level singleton — persists for the lifetime of the wizard server process.
let _proc: ReturnType<typeof spawn> | null = null;
let _inFlight: Promise<{ url: string; started: boolean }> | null = null;

// Ensure the wizard's opencode child never outlives this server. Under Electron
// the parent group-kills the whole UI-server process group, but `openpalm ui
// serve` (host CLI) has no such parent — without this, the child keeps the event
// loop alive on shutdown and orphans. Additive listeners (process.on, not once)
// so adapter-node's own SIGTERM/SIGINT graceful-shutdown handlers still run.
function killWizardOpencode(): void {
  const proc = _proc;
  if (proc && proc.exitCode === null && proc.pid) {
    try { proc.kill('SIGTERM'); } catch { /* best effort */ }
  }
  _proc = null;
  setWizardOpencodeUrl(null);
}
if (!(globalThis as Record<string, unknown>).__opWizardOpencodeReaper) {
  (globalThis as Record<string, unknown>).__opWizardOpencodeReaper = true;
  process.on('SIGTERM', killWizardOpencode);
  process.on('SIGINT', killWizardOpencode);
  process.on('exit', killWizardOpencode);
}

async function checkReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/provider`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function stopWizardOpencode(proc: ReturnType<typeof spawn> | null): Promise<void> {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => proc.once('exit', () => resolve())),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

function spawnOpencodeServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    _proc = proc;

    let resolved = false;
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Timed out waiting for OpenCode server to start (15s)'));
    }, 15_000);

    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      for (const line of out.split('\n')) {
        if (line.includes('server listening')) {
          const m = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (m) {
            resolved = true;
            clearTimeout(timer);
            resolve(m[1]);
          }
        }
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (_proc === proc) {
        _proc = null;
        setWizardOpencodeUrl(null);
      }
      if (!resolved && code !== 0) reject(new Error(`OpenCode exited (code ${code}). Output: ${out.slice(0, 300)}`));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (_proc === proc) {
        _proc = null;
        setWizardOpencodeUrl(null);
      }
      reject(err);
    });
  });
}

export const POST: RequestHandler = async () => {
  // 1. Already configured and reachable
  const configuredUrl =
    process.env.OP_OPENCODE_URL ??
    process.env.OP_ASSISTANT_URL ??
    `http://127.0.0.1:${process.env.OP_ASSISTANT_PORT ?? '3810'}`;

  if (await checkReachable(configuredUrl)) {
    return json({ ok: true, url: configuredUrl, started: false });
  }

  // 2. Previously started instance still alive
  const existingUrl = getWizardOpencodeUrl();
  if (existingUrl && await checkReachable(existingUrl)) {
    return json({ ok: true, url: existingUrl, started: false });
  }

  if (_inFlight) {
    try {
      const result = await _inFlight;
      return json({ ok: true, ...result });
    } catch (err) {
      // W15: failures used to return HTTP 200 with ok:false, which made the
      // client's `!res.ok` check (setup-api.ts) unable to tell success from
      // failure. A real HTTP status lets it distinguish the two correctly.
      return json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to start OpenCode',
      }, { status: 503 });
    }
  }

  // 3. Start a dedicated instance for this wizard session
  try {
    _inFlight = (async () => {
      await stopWizardOpencode(_proc);
      const url = await spawnOpencodeServer();
      setWizardOpencodeUrl(url);
      return { url, started: true };
    })();
    const { url, started } = await _inFlight;
    _inFlight = null;
    setWizardOpencodeUrl(url);
    return json({ ok: true, url, started });
  } catch (err) {
    _inFlight = null;
    _proc = null;
    setWizardOpencodeUrl(null);
    return json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to start OpenCode',
    }, { status: 503 });
  }
};
