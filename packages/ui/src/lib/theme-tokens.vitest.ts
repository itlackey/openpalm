import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL('./theme/tokens.css', import.meta.url)),
  'utf-8',
);

function ruleBody(pattern: RegExp): string {
  const match = TOKENS_CSS.match(pattern);
  if (!match) throw new Error(`Token rule not found: ${pattern}`);
  return match[1];
}

const LIGHT = ruleBody(
  /:root,\s*:root\[data-theme='light'\],\s*:root\[data-theme='day'\]\s*\{([^}]*)\}/,
);
const DARK = ruleBody(
  /:root\[data-theme='dark'\],\s*:root\[data-theme='night'\]\s*\{([^}]*)\}/,
);
const ROOT = ruleBody(/(?:^|\n):root\s*\{([^}]*)\}/);

function token(rule: string, name: string): string {
  const match = rule.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`--${name} not found`);
  return match[1].trim();
}

type Rgb = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return {
      r: Number.parseInt(hex[1].slice(0, 2), 16),
      g: Number.parseInt(hex[1].slice(2, 4), 16),
      b: Number.parseInt(hex[1].slice(4, 6), 16),
      a: 1,
    };
  }

  const rgba = value.match(
    /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i,
  );
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: Number(rgba[4]),
    };
  }

  throw new Error(`Unsupported color syntax: ${value}`);
}

function composite(foreground: Rgb, background: Rgb): Rgb {
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgb): number {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string): number {
  const bg = parseColor(background);
  const fg = composite(parseColor(foreground), bg);
  const lighter = Math.max(luminance(fg), luminance(bg));
  const darker = Math.min(luminance(fg), luminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Stillness theme accessibility tokens', () => {
  for (const [themeName, theme] of [
    ['light', LIGHT],
    ['dark', DARK],
  ] as const) {
    test(`${themeName} readable colors meet WCAG AA on both paper surfaces`, () => {
      const backgrounds = [token(theme, 's-paper'), token(theme, 's-paper-deep')];
      for (const foregroundName of [
        's-ink',
        's-ink-2',
        's-ink-3',
        's-seal',
        's-moss',
        's-error',
      ]) {
        for (const background of backgrounds) {
          expect(
            contrast(token(theme, foregroundName), background),
            `${themeName} --${foregroundName} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    test(`${themeName} component boundaries meet WCAG non-text contrast`, () => {
      const backgrounds = [token(theme, 's-paper'), token(theme, 's-paper-deep')];
      for (const lineName of ['s-line', 's-line-soft']) {
        for (const background of backgrounds) {
          expect(
            contrast(token(theme, lineName), background),
            `${themeName} --${lineName} on ${background}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }

  test('body and secondary type tokens respect the 14px/12px rubric floors', () => {
    expect(token(ROOT, 's-type-whisper')).toMatch(/^clamp\(1rem,/);
    expect(token(ROOT, 's-type-mark')).toBe('0.75rem');
    expect(token(ROOT, 's-type-mark-sm')).toBe('0.75rem');
    expect(token(ROOT, 's-type-deed')).toBe('0.875rem');
  });

  test('fixed text declarations never render below 12px', () => {
    for (const match of TOKENS_CSS.matchAll(/font-size:\s*([\d.]+)(px|rem)\s*;/g)) {
      const pixels = Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
      if (pixels === 0) continue;
      expect(pixels, match[0]).toBeGreaterThanOrEqual(12);
    }
  });

  test('spacing tokens stay on the 4px base grid', () => {
    for (const spacingName of ['s-sp-1', 's-sp-2', 's-sp-3', 's-sp-4', 's-sp-5', 's-sp-6', 's-sp-8']) {
      const value = token(ROOT, spacingName);
      const rem = Number.parseFloat(value);
      expect(value, `--${spacingName} should use rem`).toMatch(/^[\d.]+rem$/);
      expect((rem * 16) % 4, `--${spacingName} resolves to ${rem * 16}px`).toBe(0);
    }
  });

  test('theme colors switch atomically instead of cross-fading unreadable pairs', () => {
    expect(token(ROOT, 's-t-theme')).toBe('0s');
  });
});
