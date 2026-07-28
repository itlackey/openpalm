import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { hostAssetsChannel } from './host-assets-updater.js';
import { declaredUiChannel, uiUpdateChannel } from './ui-assets.js';

describe('host-assets channel selection', () => {
  test('maps stable and prerelease platform versions to GitHub channels', () => {
    expect(hostAssetsChannel('0.13.0')).toBe('stable');
    expect(hostAssetsChannel('0.13.0-beta.1')).toBe('prerelease');
  });

  test('explicit channel selection is shared by UI callers', () => {
    expect(uiUpdateChannel('0.13.0', 'prerelease')).toBe('prerelease');
    expect(uiUpdateChannel('0.13.0-beta.1', 'stable')).toBe('stable');
  });

  test('automatic UI and skeleton checks discover the newest channel release', () => {
    const source = readFileSync(new URL('./ui-assets.ts', import.meta.url), 'utf8');
    expect(source).toContain("? 'next' : 'latest'");
    expect(source).not.toContain('resolveHostAssetsRelease(platformVersion');
  });

  test('invalid environment channel does not alter resolution', () => {
    const previous = process.env.OP_UI_CHANNEL;
    process.env.OP_UI_CHANNEL = 'npm';
    expect(declaredUiChannel()).toBeNull();
    if (previous === undefined) delete process.env.OP_UI_CHANNEL;
    else process.env.OP_UI_CHANNEL = previous;
  });
});
