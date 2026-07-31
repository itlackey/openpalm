// Run via vitest (Node). Covers the harness-local desktop settings store (#504).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, saveSettings, settingsPath } from '../src/settings.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'op-settings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('desktop settings', () => {
  it('defaults checkPrerelease and micShortcutEnabled to false when no file exists', () => {
    expect(loadSettings(dir)).toEqual({ checkPrerelease: false, micShortcutEnabled: false });
  });

  it('round-trips a saved value', () => {
    saveSettings(dir, { checkPrerelease: true });
    expect(loadSettings(dir).checkPrerelease).toBe(true);
    saveSettings(dir, { checkPrerelease: false });
    expect(loadSettings(dir).checkPrerelease).toBe(false);
  });

  it('falls back to defaults for a corrupt file (never throws)', () => {
    writeFileSync(settingsPath(dir), '{ not json', 'utf-8');
    expect(loadSettings(dir)).toEqual({ checkPrerelease: false, micShortcutEnabled: false });
  });

  it('falls back to default for a mistyped field', () => {
    writeFileSync(settingsPath(dir), JSON.stringify({ checkPrerelease: 'yes' }), 'utf-8');
    expect(loadSettings(dir).checkPrerelease).toBe(false);
  });

  it('merges a patch over existing on-disk values', () => {
    saveSettings(dir, { checkPrerelease: true });
    // An empty patch must preserve the existing value.
    const merged = saveSettings(dir, {});
    expect(merged.checkPrerelease).toBe(true);
  });

  it('ignores a legacy preferClientChat field without rejecting the settings file', () => {
    writeFileSync(
      settingsPath(dir),
      JSON.stringify({ checkPrerelease: true, preferClientChat: true }),
      'utf-8',
    );
    expect(loadSettings(dir)).toEqual({ checkPrerelease: true, micShortcutEnabled: false });
  });

  it('drops legacy fields the next time current settings are saved', () => {
    writeFileSync(
      settingsPath(dir),
      JSON.stringify({ checkPrerelease: false, preferClientChat: true }),
      'utf-8',
    );
    saveSettings(dir, { checkPrerelease: true });
    expect(JSON.parse(readFileSync(settingsPath(dir), 'utf-8'))).toEqual({
      checkPrerelease: true,
      micShortcutEnabled: false,
    });
  });

  // E3 review: Ctrl/Cmd+Shift+M is Teams' global mute chord. Registering it
  // system-wide unconditionally silently took it away from every other app on
  // a first launch. It must default OFF and round-trip like any other setting.
  describe('micShortcutEnabled (E3 opt-in)', () => {
    it('defaults to false', () => {
      expect(loadSettings(dir).micShortcutEnabled).toBe(false);
    });

    it('round-trips a saved value independently of checkPrerelease', () => {
      saveSettings(dir, { micShortcutEnabled: true });
      expect(loadSettings(dir)).toEqual({ checkPrerelease: false, micShortcutEnabled: true });
      saveSettings(dir, { micShortcutEnabled: false });
      expect(loadSettings(dir).micShortcutEnabled).toBe(false);
    });

    it('falls back to default for a mistyped field', () => {
      writeFileSync(settingsPath(dir), JSON.stringify({ micShortcutEnabled: 'on' }), 'utf-8');
      expect(loadSettings(dir).micShortcutEnabled).toBe(false);
    });
  });
});
