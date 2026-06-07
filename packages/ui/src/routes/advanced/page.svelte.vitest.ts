import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdvancedPage from './+page.svelte';
import { resetThemeForTests, themeService } from '$lib/theme-state.svelte.js';

vi.mock('$app/state', () => ({
  page: {
    url: new URL('http://localhost/advanced'),
  },
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
}));

vi.mock('$lib/endpoints-state.svelte.js', () => ({
  endpointsService: {
    active: { id: 'default', label: 'Local assistant', url: 'http://127.0.0.1:3800', isDefault: true },
    load: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('$lib/chat/chat-state.svelte.js', () => ({
  chat: {
    sending: false,
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('$lib/voice/voice-state.svelte.js', () => ({
  voiceState: {
    sttEngine: 'disabled',
    sttSupported: false,
    ttsSupported: false,
    status: 'idle',
    interimTranscript: '',
    autoplayBlocked: false,
    ttsAutoEnabled: false,
  },
  initVoice: vi.fn().mockResolvedValue(undefined),
  destroyVoice: vi.fn(),
  startListening: vi.fn(),
  stopListening: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsAutoEnabled: vi.fn(),
  resumeAutoplay: vi.fn(),
}));

describe('/advanced/+page.svelte', () => {
  beforeEach(() => {
    resetThemeForTests();
    themeService.init();
  });

  afterEach(() => {
    resetThemeForTests();
  });

  test('opens the settings drawer above the OpenCode iframe', async () => {
    render(AdvancedPage);

    const iframe = page.getByTitle('OpenCode — Advanced Chat');
    await expect.element(iframe).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();

    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByRole('link', { name: 'Manage this assistant...' })).toBeVisible();

    const drawerElement = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]');
    const iframeElement = document.querySelector<HTMLIFrameElement>('iframe[title="OpenCode — Advanced Chat"]');

    expect(drawerElement).not.toBeNull();
    expect(iframeElement).not.toBeNull();

    const drawerPosition = drawerElement ? getComputedStyle(drawerElement).position : '';
    const drawerZIndex = drawerElement ? getComputedStyle(drawerElement).zIndex : '0';
    const iframeZIndex = iframeElement ? getComputedStyle(iframeElement).zIndex : '0';

    expect(drawerPosition).toBe('fixed');
    expect(Number.parseInt(drawerZIndex, 10)).toBeGreaterThan(Number.parseInt(iframeZIndex, 10) || 0);
  });
});
