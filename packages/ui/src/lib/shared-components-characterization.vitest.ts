/**
 * Representative shared components render the expected markup. The full
 * interaction coverage stays in the co-located browser-project tests; this
 * node-project suite covers the same basic contract in environments that
 * cannot launch a browser.
 */
import { describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRawSnippet, type Component } from 'svelte';
import { render } from 'svelte/server';

function resolveComponentPath(rel: string): string {
  const path = fileURLToPath(new URL(`./components/${rel}`, import.meta.url));
  if (existsSync(path)) return path;
  throw new Error(`shared component ${rel} not found`);
}

async function loadComponent(rel: string): Promise<Component> {
  const mod = await import(/* @vite-ignore */ resolveComponentPath(rel));
  return mod.default;
}

const icon = createRawSnippet(() => ({
  render: () => '<svg data-icon aria-hidden="true" width="16" height="16"></svg>'
}));

describe('IconButton renders identically from either package (P5a characterization)', () => {
  test('renders a button with its visible label', async () => {
    const IconButton = await loadComponent('common/IconButton.svelte');
    const { body } = render(IconButton, { props: { icon, label: 'Save' } });
    expect(body).toContain('<button');
    expect(body).toContain('aria-label="Save"');
    expect(body).toContain('icon-btn-label');
    expect(body).toContain('Save');
    expect(body).toContain('data-icon');
  });

  test('renders as an anchor when href is given', async () => {
    const IconButton = await loadComponent('common/IconButton.svelte');
    const { body } = render(IconButton, {
      props: { icon, ariaLabel: 'Home', href: '/chat' }
    });
    expect(body).toContain('<a');
    expect(body).toContain('href="/chat"');
    expect(body).not.toContain('<button');
  });

  test('renders the disabled attribute when disabled', async () => {
    const IconButton = await loadComponent('common/IconButton.svelte');
    const { body } = render(IconButton, {
      props: { icon, ariaLabel: 'Go', disabled: true }
    });
    expect(body).toContain('<button');
    expect(body).toContain('disabled');
  });
});

describe('IconClose renders identically from either package (P5a characterization)', () => {
  test('renders a decorative 20px svg by default', async () => {
    const IconClose = await loadComponent('icons/IconClose.svelte');
    const { body } = render(IconClose, { props: {} });
    expect(body).toContain('<svg');
    expect(body).toContain('aria-hidden="true"');
    expect(body).toContain('width="20"');
    expect(body).toContain('s-icon');
  });

  test('honors the size prop', async () => {
    const IconClose = await loadComponent('icons/IconClose.svelte');
    const { body } = render(IconClose, { props: { size: 16 } });
    expect(body).toContain('width="16"');
    expect(body).toContain('height="16"');
  });
});
