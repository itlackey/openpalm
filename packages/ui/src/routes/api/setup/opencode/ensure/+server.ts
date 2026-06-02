/**
 * POST /api/setup/opencode/ensure
 *
 * Ensures an OpenCode server is running for the setup wizard.
 * 1. Checks the configured OP_OPENCODE_URL / OP_ASSISTANT_PORT first.
 * 2. If unreachable, starts a dedicated `opencode serve` subprocess via the SDK.
 * 3. Returns { ok, url, started } — client updates its OP_OPENCODE_URL accordingly.
 *
 * No auth required — called during pre-setup wizard initialization.
 */
import { spawn } from 'node:child_process';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Module-level singleton — persists for the lifetime of the wizard server process.
let _url: string | null = null;
let _proc: ReturnType<typeof spawn> | null = null;

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

function spawnOpencodeServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    _proc = proc;

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
            clearTimeout(timer);
            resolve(m[1]);
          }
        }
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`OpenCode exited (code ${code}). Output: ${out.slice(0, 300)}`));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export const POST: RequestHandler = async () => {
  // 1. Already configured and reachable
  const configuredUrl =
    process.env.OP_OPENCODE_URL ??
    process.env.OP_ASSISTANT_URL ??
    `http://localhost:${process.env.OP_ASSISTANT_PORT ?? '3800'}`;

  if (await checkReachable(configuredUrl)) {
    return json({ ok: true, url: configuredUrl, started: false });
  }

  // 2. Previously started instance still alive
  if (_url && await checkReachable(_url)) {
    return json({ ok: true, url: _url, started: false });
  }

  // 3. Start a dedicated instance for this wizard session
  try {
    const url = await spawnOpencodeServer();
    _url = url;
    // Override so opencodeFetch picks up the new URL for the rest of setup
    process.env.OP_OPENCODE_URL = url;
    return json({ ok: true, url, started: true });
  } catch (err) {
    return json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to start OpenCode',
    });
  }
};
