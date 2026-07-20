import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const CHAT_NAVBAR = fileURLToPath(new URL('./ChatNavbar.svelte', import.meta.url));
const NAVBAR = fileURLToPath(new URL('./Navbar.svelte', import.meta.url));
const MODE_SWITCH = fileURLToPath(new URL('./ModeSwitch.svelte', import.meta.url));

describe('conversation navbar contract', () => {
  test('owns one drawer and exposes its open state to route content', () => {
    const source = readFileSync(CHAT_NAVBAR, 'utf8');

    expect(source).toContain('drawerOpen = $bindable(false)');
    expect(source.match(/<Drawer\b/g)).toHaveLength(1);
    expect(source).toMatch(/<Navbar[^>]*inactive=\{drawerOpen\}[^>]*showUtilities=\{false\}/);
    expect(source).not.toContain('NewChatButton');
    expect(source).not.toContain('<span>Settings</span>');
    expect(source).not.toContain('VoiceControl');
  });

  test('builds the settings destination from mode, session, and assistant context', () => {
    const source = readFileSync(CHAT_NAVBAR, 'utf8');

    expect(source).toMatch(/buildConversationPath\([^,]+,[^,]+,[^)]+\)/);
    expect(source).toContain("buildReturnToPath(resolve('/connections'), conversationPath)");
    expect(source).not.toContain("resolve('/settings/voice')");
  });

  test('keeps the generic navbar free of chat state and supports inert utilities-free composition', () => {
    const source = readFileSync(NAVBAR, 'utf8');

    expect(source).toContain('inactive?: boolean');
    expect(source).toContain('showUtilities?: boolean');
    expect(source).toMatch(/<header[^>]*inert=\{inactive\}/);
    expect(source).not.toMatch(/components\/chat|chat-state/);
  });

  test('names the mode destination instead of presenting a permanent advanced-mode concept', () => {
    const source = readFileSync(MODE_SWITCH, 'utf8');

    expect(source).toContain('Simple mode');
    expect(source).toContain('OpenCode mode');
    expect(source).toContain("page.url.searchParams.get('assistant')");
    expect(source).not.toContain('ariaLabel="Advanced mode"');
  });
});
