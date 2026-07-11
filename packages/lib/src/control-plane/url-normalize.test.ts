import { describe, expect, it } from 'bun:test';
import { normalizeLoopbackUrl } from './url-normalize.js';

describe('normalizeLoopbackUrl', () => {
  it('rewrites a bare 0.0.0.0 host to 127.0.0.1', () => {
    expect(normalizeLoopbackUrl('http://0.0.0.0:3800')).toBe('http://127.0.0.1:3800');
  });

  it('rewrites 0.0.0.0 with no port and a path', () => {
    expect(normalizeLoopbackUrl('http://0.0.0.0/chat')).toBe('http://127.0.0.1/chat');
    expect(normalizeLoopbackUrl('https://0.0.0.0')).toBe('https://127.0.0.1');
  });

  it('rewrites the IPv6 wildcard form [::]', () => {
    expect(normalizeLoopbackUrl('http://[::]:3800')).toBe('http://127.0.0.1:3800');
    expect(normalizeLoopbackUrl('http://[::]/chat')).toBe('http://127.0.0.1/chat');
  });

  it('rewrites a bare :: host with no port', () => {
    expect(normalizeLoopbackUrl('http://::/chat')).toBe('http://127.0.0.1/chat');
    expect(normalizeLoopbackUrl('http://::')).toBe('http://127.0.0.1');
  });

  it('is case-insensitive on the scheme', () => {
    expect(normalizeLoopbackUrl('HTTP://0.0.0.0:3800')).toBe('HTTP://127.0.0.1:3800');
  });

  it('leaves non-wildcard hosts untouched', () => {
    expect(normalizeLoopbackUrl('http://127.0.0.1:3800')).toBe('http://127.0.0.1:3800');
    expect(normalizeLoopbackUrl('https://example.test:9999/path')).toBe('https://example.test:9999/path');
    expect(normalizeLoopbackUrl('http://10.0.0.5:3800')).toBe('http://10.0.0.5:3800');
  });

  it('does not touch a host that merely starts with the wildcard digits (e.g. 0.0.0.0.example.test)', () => {
    expect(normalizeLoopbackUrl('http://0.0.0.0.example.test:3800')).toBe('http://0.0.0.0.example.test:3800');
  });
});
