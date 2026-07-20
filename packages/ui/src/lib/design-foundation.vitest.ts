import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHAT_MESSAGE = readFileSync(
  fileURLToPath(new URL('./components/chat/ChatMessage.svelte', import.meta.url)),
  'utf-8',
);
const CHAT_INPUT = readFileSync(
  fileURLToPath(new URL('./components/chat/ChatInput.svelte', import.meta.url)),
  'utf-8',
);
const APP_CSS = readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf-8');

function styleRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Style rule not found: ${selector}`);
  return match[1];
}

describe('chat visual foundation', () => {
  test('assistant prose uses the productive body scale and a readable measure', () => {
    const prose = styleRule(CHAT_MESSAGE, '.master-words');
    expect(prose).toContain('font-weight: 400');
    expect(prose).toContain('font-size: var(--s-type-whisper)');
    expect(prose).toContain('max-width: var(--s-measure-whisper)');
    expect(prose).not.toContain('max-width: 80%');
  });

  test('assistant prose can use the full available width on mobile', () => {
    const prose = styleRule(CHAT_MESSAGE, '.master-words');
    expect(prose).toContain('width: 100%');
  });

  test('the composer does not animate text color during a theme switch', () => {
    const textarea = styleRule(CHAT_INPUT, '.s-composer textarea');
    expect(textarea).not.toContain('--s-t-theme');
  });
});

describe('app visual foundation', () => {
  test('fixed text declarations never render below 12px', () => {
    for (const match of APP_CSS.matchAll(/font-size:\s*([\d.]+)(px|rem)\s*;/g)) {
      const pixels = Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
      if (pixels === 0) continue;
      expect(pixels, match[0]).toBeGreaterThanOrEqual(12);
    }
  });

  test('shared buttons and common icon controls declare 44px targets', () => {
    const button = styleRule(APP_CSS, '.btn');
    const smallButton = styleRule(APP_CSS, '.btn-sm');
    const iconControls = styleRule(APP_CSS, '.icon-btn,\nbutton.btn-icon.btn-icon,\n.btn-dismiss');

    expect(button).toContain('min-width: 44px');
    expect(button).toContain('min-height: 44px');
    expect(smallButton).toContain('min-width: 44px');
    expect(smallButton).toContain('min-height: 44px');
    expect(iconControls).toContain('min-width: 44px');
    expect(iconControls).toContain('min-height: 44px');
  });

  test('danger controls use the error role while primary remains the only filled button role', () => {
    const primary = styleRule(APP_CSS, '.btn-primary');
    const danger = styleRule(APP_CSS, '.btn-danger');

    expect(primary).toContain('background: var(--s-seal)');
    expect(danger).toContain('color: var(--s-error)');
    expect(danger).toContain('border-color: var(--s-error)');
    expect(danger).toContain('background: transparent');
    expect(danger).not.toContain('var(--s-seal)');
    expect(danger).not.toContain('opacity:');
  });
});
