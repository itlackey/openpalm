import { describe, expect, test, vi } from 'vitest';

vi.mock('$lib/chat/chat-state.svelte.js', () => ({
  chat: { activeEndpointId: 'active-assistant', activeSessionId: 'active-session' },
}));

import {
  buildAdvancedPath,
  buildChatPath,
  buildConversationPath,
  buildReturnToPath,
  resolveReturnToPath,
} from './navigation.js';

describe('conversation navigation', () => {
  test('keeps one-argument session URLs backward compatible', () => {
    expect(buildChatPath('session/one')).toBe('/chat?session=session%2Fone');
    expect(buildAdvancedPath('session/one')).toBe('/advanced?session=session%2Fone');
  });

  test('builds exact conversation locators in stable session then assistant order', () => {
    expect(buildChatPath('session/one', 'assistant&one')).toBe(
      '/chat?session=session%2Fone&assistant=assistant%26one',
    );
    expect(buildAdvancedPath('session/one', 'assistant&one')).toBe(
      '/advanced?session=session%2Fone&assistant=assistant%26one',
    );
    expect(buildChatPath(null, 'assistant/one')).toBe('/chat?assistant=assistant%2Fone');
  });

  test('keeps the current simple or advanced mode when selecting a session', () => {
    expect(buildConversationPath('/chat', 'session-1', 'assistant-1')).toBe(
      '/chat?session=session-1&assistant=assistant-1',
    );
    expect(buildConversationPath('/advanced', 'session-1', 'assistant-1')).toBe(
      '/advanced?session=session-1&assistant=assistant-1',
    );
    expect(buildConversationPath('/advanced/tools', null)).toBe('/advanced');
  });

  test('does not put an internal browser connection id in the URL', () => {
    const path = buildConversationPath('/chat', 'session-1');

    expect(path).not.toContain('connection');
    expect(path).not.toContain('browser-connection-id');
  });

  test('encodes return context without dropping destination query or fragments', () => {
    expect(buildReturnToPath('/connections', '/chat?session=session/one')).toBe(
      '/connections?returnTo=%2Fchat%3Fsession%3Dsession%2Fone',
    );
    expect(buildReturnToPath('/connections?new=1#pair=code', '/advanced?session=session-1')).toBe(
      '/connections?new=1&returnTo=%2Fadvanced%3Fsession%3Dsession-1#pair=code',
    );
    expect(
      buildReturnToPath(
        '/host?tab=addons&addon=voice',
        '/advanced?session=session-1&assistant=assistant-1',
      ),
    ).toBe(
      '/host?tab=addons&addon=voice&returnTo=%2Fadvanced%3Fsession%3Dsession-1%26assistant%3Dassistant-1',
    );
  });

  test('accepts only internal chat and advanced return paths', () => {
    const fallback = '/chat?session=current';

    expect(resolveReturnToPath('/chat?session=simple', fallback)).toBe('/chat?session=simple');
    expect(resolveReturnToPath('/advanced?session=expert', fallback)).toBe(
      '/advanced?session=expert',
    );
    expect(resolveReturnToPath('https://evil.example/chat', fallback)).toBe(fallback);
    expect(resolveReturnToPath('//evil.example/chat', fallback)).toBe(fallback);
    expect(resolveReturnToPath('/\\evil.example/chat', fallback)).toBe(fallback);
    expect(resolveReturnToPath('javascript:alert(1)', fallback)).toBe(fallback);
    expect(resolveReturnToPath('/connections', fallback)).toBe(fallback);
    expect(resolveReturnToPath('/chatty', fallback)).toBe(fallback);
  });

  test('keeps a query-carried session across reload instead of replacing it with fallback state', () => {
    expect(resolveReturnToPath('/advanced?session=before-reload', '/chat')).toBe(
      '/advanced?session=before-reload',
    );
    expect(resolveReturnToPath(null, '/advanced?session=current')).toBe(
      '/advanced?session=current',
    );
  });

  test('preserves assistant identity from an exact return or fallback locator', () => {
    const fallback = '/chat?session=current&assistant=local-assistant';

    expect(
      resolveReturnToPath('/advanced?session=expert&assistant=remote-assistant', fallback),
    ).toBe('/advanced?session=expert&assistant=remote-assistant');
    expect(resolveReturnToPath('https://evil.example/chat', fallback)).toBe(fallback);
    expect(resolveReturnToPath(undefined)).toBe(
      '/chat?session=active-session&assistant=active-assistant',
    );
  });
});
