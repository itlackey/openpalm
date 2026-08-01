import { describe, expect, test } from 'vitest';
import { resolveChromiumLaunchTarget } from './chromium-launch-target.js';

describe('PWA Chromium launch target resolution', () => {
  test('keeps an explicit executable first even when automatic candidates exist', () => {
    expect(
      resolveChromiumLaunchTarget(' /custom/chrome ', '/playwright/chromium', {
        env: { PATH: '/usr/bin' },
        exists: () => true,
      }),
    ).toEqual({ executablePath: '/custom/chrome' });
  });

  test('uses Playwright full Chromium when it is installed', () => {
    expect(
      resolveChromiumLaunchTarget(undefined, '/playwright/chromium', {
        env: { PATH: '/usr/bin' },
        exists: (path) => path === '/playwright/chromium',
      }),
    ).toEqual({ executablePath: '/playwright/chromium' });
  });

  test('finds an installed Chromium on PATH when Playwright Chromium is absent', () => {
    expect(
      resolveChromiumLaunchTarget(undefined, '/missing/playwright/chromium', {
        platform: 'linux',
        env: { PATH: '/opt/bin:/usr/bin' },
        exists: (path) => path === '/usr/bin/chromium',
      }),
    ).toEqual({ executablePath: '/usr/bin/chromium' });
  });

  test('falls back to branded Chrome when no Chromium executable is installed', () => {
    expect(
      resolveChromiumLaunchTarget(undefined, '/missing/playwright/chromium', {
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        exists: () => false,
      }),
    ).toEqual({ channel: 'chrome' });
  });
});
