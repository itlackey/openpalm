import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// serve.mjs must survive hostile requests: a malformed percent-escape in the
// path (e.g. /%zz) makes decodeURIComponent throw, and an uncaught throw in
// the request handler kills the whole co-process that P5c/P5d rely on.

const SERVE = fileURLToPath(new URL('../bin/serve.mjs', import.meta.url));
const PORT = 41000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

let dir: string;
let child: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'op-client-serve-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ok</title>');
  child = Bun.spawn(['node', SERVE, '--port', String(PORT), '--dir', dir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // wait for the listen log
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('serve.mjs did not start');
});

afterAll(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe('serve.mjs resilience', () => {
  it('returns 400 for a malformed percent-escape instead of crashing', async () => {
    const res = await fetch(`${BASE}/%zz`);
    expect(res.status).toBe(400);
  });

  it('keeps serving after the malformed request (process not killed)', async () => {
    await fetch(`${BASE}/%zz`).catch(() => undefined);
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ok');
  });

  it('still SPA-falls-back for normal unknown routes', async () => {
    const res = await fetch(`${BASE}/connections/new`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
