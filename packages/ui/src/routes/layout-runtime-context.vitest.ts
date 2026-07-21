import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const LAYOUT_PATH = fileURLToPath(new URL('./+layout.svelte', import.meta.url));
const APP_LAYOUT_PATH = fileURLToPath(new URL('./(app)/+layout.svelte', import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
const SVELTE_CONFIG_PATH = fileURLToPath(new URL('../../svelte.config.js', import.meta.url));

describe('+layout.svelte runtime context ownership', () => {
  const source = readFileSync(LAYOUT_PATH, 'utf8');

  test('creates and provides request-local context before rendering children', () => {
    const createIndex = source.indexOf('createRuntimeContext(data.serverRuntimeContext)');
    const provideIndex = source.indexOf('provideRuntimeContext(runtimeContext)');
    const childrenIndex = source.indexOf('{@render children?.()}');

    expect(createIndex).toBeGreaterThan(-1);
    expect(provideIndex).toBeGreaterThan(createIndex);
    expect(childrenIndex).toBeGreaterThan(provideIndex);
  });

  test('keeps visible application framing below the global infrastructure layout', () => {
    const appLayout = readFileSync(APP_LAYOUT_PATH, 'utf8');
    expect(source).not.toContain('UpdateBanner');
    expect(appLayout).toContain('<UpdateBanner />');
    expect(appLayout).toContain('{@render children?.()}');
  });

  test('isolates the dev route manifest from check and build output', () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      scripts: Record<string, string>;
    };
    const config = readFileSync(SVELTE_CONFIG_PATH, 'utf8');

    expect(packageJson.scripts.dev).toMatch(/^svelte-kit sync && /);
    expect(packageJson.scripts.dev).toContain('OP_SVELTEKIT_OUT_DIR=.svelte-kit/dev');
    expect(config).toContain('outDir: process.env.OP_SVELTEKIT_OUT_DIR ?? ".svelte-kit"');
  });

  test('adds browser-only display context after mount', () => {
    const onMountBlock = source.slice(source.indexOf('onMount(() => {'));
    expect(onMountBlock).toContain('detectClientDisplayMode()');
    expect(onMountBlock).toContain('initializeRuntimeContext(runtimeContext');
  });
});
