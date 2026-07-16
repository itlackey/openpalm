import { describe, expect, test } from 'vitest';
import config from '../svelte.config.js';

describe('production CSP config', () => {
  test('permits runtime-selected HTTP(S) OpenCode frames and direct connections without relaxing other resource types', () => {
    const directives = config.kit?.csp?.directives;

    expect(config.kit?.csp?.mode).toBe('hash');
    expect(directives?.['frame-src']).toEqual(['self', 'http:', 'https:']);
    // Phase 3b: the browser fetches the active connection's OpenCode/Guardian
    // baseUrl directly (no host proxy), so connect-src permits HTTP(S) too.
    expect(directives?.['connect-src']).toEqual(['self', 'http:', 'https:']);
    expect(directives?.['default-src']).toEqual(['self']);
    expect(directives?.['script-src']).toEqual(['self']);
    expect(directives?.['object-src']).toEqual(['none']);
    expect(directives?.['base-uri']).toEqual(['none']);
    expect(directives?.['frame-ancestors']).toEqual(['none']);
  });
});
