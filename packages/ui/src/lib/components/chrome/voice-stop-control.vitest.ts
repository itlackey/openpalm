/**
 * Review 2026-07-10 K1 — /host mounted the bare Navbar with no way to stop
 * in-flight TTS (module-level voiceState/audio survives SPA navigation from
 * /chat). Fix: a minimal VoiceStopControl mounted alongside Navbar on
 * /host, wired only to $lib/voice/voice-state (not the full chat
 * VoiceControl, which the chrome-untangle hygiene forbids in the admin
 * bundle — see chrome-untangle-hygiene.vitest.ts).
 *
 * Source-level assertions (same convention as the hygiene suites): a real
 * component-render test needs the unrunnable browser vitest project
 * (chromium headless-shell unavailable in this sandbox).
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONTROL_PATH = fileURLToPath(new URL('./VoiceStopControl.svelte', import.meta.url));
const HOST_PAGE_PATH = fileURLToPath(new URL('../../../routes/host/+page.svelte', import.meta.url));

describe('VoiceStopControl (review 2026-07-10 K1)', () => {
  test('the component exists', () => {
    expect(existsSync(CONTROL_PATH)).toBe(true);
  });

  test('it imports only the pure voice-state module, never chat/chat-state (chrome-untangle safe)', () => {
    const source = readFileSync(CONTROL_PATH, 'utf-8');
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    expect(importLines.some((line) => /\$lib\/voice\/voice-state\.svelte\.js/.test(line))).toBe(true);
    expect(importLines.some((line) => /chat-state/.test(line) || /(?:^|\/)chat\//.test(line))).toBe(false);
  });

  test('it reads voiceState.status and calls stopSpeaking on click', () => {
    const source = readFileSync(CONTROL_PATH, 'utf-8');
    expect(source).toMatch(/voiceState\.status\s*===\s*'speaking'/);
    expect(source).toMatch(/stopSpeaking\(\)/);
  });

  test('/host/+page.svelte mounts VoiceStopControl inside Navbar', () => {
    const source = readFileSync(HOST_PAGE_PATH, 'utf-8');
    expect(source).toMatch(/import VoiceStopControl from ['"]\$lib\/components\/chrome\/VoiceStopControl\.svelte['"]/);
    expect(source).toMatch(/<Navbar(?:\s[^>]*)?>[\s\S]*<VoiceStopControl\s*\/>[\s\S]*<\/Navbar>/);
  });
});
