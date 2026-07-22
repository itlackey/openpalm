import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const CHAT_NAVBAR = fileURLToPath(new URL('./ChatNavbar.svelte', import.meta.url));
const NAVBAR = fileURLToPath(new URL('./Navbar.svelte', import.meta.url));
const CONVERSATION_NAV = fileURLToPath(new URL('./ConversationNav.svelte', import.meta.url));

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

  test('hides conversation switchers in a compact, smoothly transitioned OpenCode frame', () => {
    const source = readFileSync(CHAT_NAVBAR, 'utf8');

    expect(source).toContain('showConversationControls = true');
    expect(source).toMatch(/conversation=\{showConversationControls\}/);
    expect(source).toMatch(/\{#if showConversationControls\}[\s\S]*?<EndpointSwitcher/);
    expect(source).toMatch(/class:context-hidden=\{!showConversationControls\}/);
    expect(source).toMatch(
      /\.chat-nav\.context-hidden\s*\{[\s\S]*?height:\s*52px;[\s\S]*?flex-direction:\s*row/,
    );
    expect(source).toContain('transition: height 220ms var(--s-ease)');
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
    const source = readFileSync(CONVERSATION_NAV, 'utf8');

    expect(source).toContain('ariaLabel="Chat"');
    expect(source).toContain('ariaLabel="Advanced"');
    expect(source).toContain('IconButton');
    expect(source).toContain('IconChat');
    expect(source).toContain('IconTerminal');
    expect(source).toContain("'startViewTransition' in document");
    expect(source).not.toMatch(/>Chat<|>Advanced</);
    expect(source).toContain("page.url.searchParams.get('assistant')");
    expect(source).toContain("ariaCurrent={onChat ? 'page' : undefined}");
    expect(source).toContain("ariaCurrent={onAdvanced ? 'page' : undefined}");
    expect(source).not.toContain('ariaLabel="Advanced mode"');
  });
});
