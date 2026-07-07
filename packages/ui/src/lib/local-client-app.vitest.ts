import { describe, expect, test, vi } from 'vitest';
import { openLocalClientApp } from './local-client-app.js';

describe('openLocalClientApp', () => {
  test('uses the Electron bridge when available', () => {
    const openLocalApp = vi.fn().mockResolvedValue(undefined);
    const opener = vi.fn();

    const result = openLocalClientApp('http://127.0.0.1:3890/chat', { openLocalApp }, opener);

    expect(result).toBe('bridge');
    expect(openLocalApp).toHaveBeenCalledTimes(1);
    expect(opener).not.toHaveBeenCalled();
  });

  test('falls back to opening the stable localhost client URL in a new tab', () => {
    const opener = vi.fn();

    const result = openLocalClientApp('http://127.0.0.1:3890/chat', undefined, opener);

    expect(result).toBe('window');
    expect(opener).toHaveBeenCalledWith('http://127.0.0.1:3890/chat', '_blank', 'noopener');
  });
});
