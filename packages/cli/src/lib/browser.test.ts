import { afterEach, describe, expect, it } from 'bun:test';
import { openBrowser } from './browser.ts';

/**
 * C5: `openBrowser` used to report success unconditionally (a bare
 * `console.log('Opening ... in your browser...')` regardless of outcome), so
 * a headless/SSH host where `xdg-open` fails at runtime (no DISPLAY, no
 * configured opener) was told the browser opened when it did not. It now
 * reports the opener's real exit outcome so callers can print an honest
 * message.
 */
describe('openBrowser', () => {
  const originalSpawn = Bun.spawn;
  const originalPlatform = process.platform;

  afterEach(() => {
    Bun.spawn = originalSpawn;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function fakeProc(exitCode: number): Bun.Subprocess {
    return { exited: Promise.resolve(exitCode) } as unknown as Bun.Subprocess;
  }

  it('reports success when the opener exits 0', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Bun.spawn = (() => fakeProc(0)) as unknown as typeof Bun.spawn;
    expect(await openBrowser('http://127.0.0.1:3880/setup')).toBe(true);
  });

  it('reports failure when the opener exits non-zero (e.g. xdg-open with no DISPLAY)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Bun.spawn = (() => fakeProc(1)) as unknown as typeof Bun.spawn;
    expect(await openBrowser('http://127.0.0.1:3880/setup')).toBe(false);
  });

  it('reports failure when spawning the opener throws (binary not found)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Bun.spawn = (() => {
      throw new Error('Executable not found in $PATH: "xdg-open"');
    }) as unknown as typeof Bun.spawn;
    expect(await openBrowser('http://127.0.0.1:3880/setup')).toBe(false);
  });
});
