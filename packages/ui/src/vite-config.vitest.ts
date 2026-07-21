import { describe, expect, test } from 'vitest';
import type { Plugin } from 'vite';
import { isolateVitestBrowserDynamicImports } from '../vite.config.js';

describe('Vitest browser SSR compatibility', () => {
  test('limits the browser dynamic-import wrapper to Vite client environments', async () => {
    const injector: Plugin = { name: 'vitest:browser:esm-injector' };
    const compatibility = isolateVitestBrowserDynamicImports();
    const configure = compatibility.configResolved;
    if (typeof configure !== 'function') throw new Error('Expected a configResolved hook.');

    await configure.call({} as never, { plugins: [injector] } as never);

    expect(injector.applyToEnvironment).toBeTypeOf('function');
    const applies = injector.applyToEnvironment;
    if (!applies) throw new Error('Expected an environment filter.');
    expect(await applies({ name: 'client' } as never)).toBe(true);
    expect(await applies({ name: 'ssr' } as never)).toBe(false);
  });
});
