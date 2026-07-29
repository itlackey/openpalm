import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PasswordInput from '$lib/components/common/PasswordInput.svelte';
import '../app.css';

type Rgb = { r: number; g: number; b: number; a: number };

function parseRgb(value: string): Rgb {
  const channels = value.match(/[\d.]+/g)?.map(Number);
  if (!channels || channels.length < 3) throw new Error(`Unsupported color: ${value}`);
  return { r: channels[0], g: channels[1], b: channels[2], a: channels[3] ?? 1 };
}

function composite(foreground: Rgb, background: Rgb): Rgb {
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1,
  };
}

function luminance(color: Rgb): number {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: Rgb, background: Rgb): number {
  const opaqueForeground = composite(foreground, background);
  const [lighter, darker] = [luminance(opaqueForeground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function appendControl(className: string, tagName: 'button' | 'a' = 'button'): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = 'Control';
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

describe('computed design foundation', () => {
  test('shared buttons and icon controls compute to at least 44px in both dimensions', () => {
    const controls = [
      appendControl('btn'),
      appendControl('btn btn-sm'),
      appendControl('icon-btn'),
      appendControl('btn-icon'),
      appendControl('btn-dismiss'),
    ];

    for (const control of controls) {
      const bounds = control.getBoundingClientRect();
      expect(bounds.width, control.className).toBeGreaterThanOrEqual(44);
      expect(bounds.height, control.className).toBeGreaterThanOrEqual(44);
    }
  });

  test('the shared target overrides scoped icon-control sizing', () => {
    const { container } = render(PasswordInput);
    const toggle = container.querySelector('.btn-icon');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('password toggle not found');

    const bounds = toggle.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  });

  test('ordinary text links remain inline instead of becoming button targets', () => {
    const link = appendControl('text-link', 'a');
    const style = getComputedStyle(link);

    expect(style.display).toBe('inline');
    expect(style.minWidth).toBe('0px');
    expect(style.minHeight).toBe('0px');
  });

  test.each(['light', 'dark'] as const)('danger controls meet AA contrast in the %s theme', (theme) => {
    document.documentElement.dataset.theme = theme;
    const surface = document.createElement('div');
    surface.style.background = 'var(--s-paper)';
    const danger = document.createElement('button');
    danger.className = 'btn btn-danger';
    danger.textContent = 'Disable';
    surface.append(danger);
    document.body.append(surface);

    const surfaceColor = parseRgb(getComputedStyle(surface).backgroundColor);
    const style = getComputedStyle(danger);
    expect(contrast(parseRgb(style.color), surfaceColor)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseRgb(style.borderTopColor), surfaceColor)).toBeGreaterThanOrEqual(3);
  });

  test('primary is the only persistently filled shared button role', () => {
    const surface = document.createElement('div');
    surface.style.background = 'var(--s-paper)';
    const roles = ['primary', 'secondary', 'outline', 'danger'] as const;
    const buttons = roles.map((role) => {
      const button = document.createElement('button');
      button.className = `btn btn-${role}`;
      button.textContent = role;
      surface.append(button);
      return button;
    });
    document.body.append(surface);

    const paper = getComputedStyle(surface).backgroundColor;
    expect(getComputedStyle(buttons[0]).backgroundColor).not.toBe(paper);
    for (const button of buttons.slice(1)) {
      const background = getComputedStyle(button).backgroundColor;
      expect([paper, 'rgba(0, 0, 0, 0)'], button.className).toContain(background);
    }
  });
});
