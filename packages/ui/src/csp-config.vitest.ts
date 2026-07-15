import { describe, expect, test } from 'vitest';
import config from '../svelte.config.js';

describe('production CSP config', () => {
  test('permits runtime-selected HTTP(S) OpenCode frames without relaxing other resource types', () => {
    const directives = config.kit?.csp?.directives;

    expect(config.kit?.csp?.mode).toBe('hash');
    expect(directives?.['frame-src']).toEqual(['self', 'http:', 'https:']);
    expect(directives?.['default-src']).toEqual(['self']);
    expect(directives?.['script-src']).toEqual(['self']);
    expect(directives?.['connect-src']).toEqual(['self']);
    expect(directives?.['object-src']).toEqual(['none']);
    expect(directives?.['base-uri']).toEqual(['none']);
    expect(directives?.['frame-ancestors']).toEqual(['none']);
  });
});
