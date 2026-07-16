/**
 * P5a (#555) CHARACTERIZATION — representative shared components render the
 * same markup regardless of which package they live in: the extraction is "pure
 * file moves + import rewrites; zero behavior change".
 *
 * GREEN before AND after the move: the two representative components
 * (IconButton from common/, IconClose from icons/) are resolved from
 * packages/ui-kit first and fall back to the current packages/ui location,
 * so this suite pins their rendered contract across the relocation. The
 * full interaction coverage stays in the co-located browser-project tests
 * (IconButton.svelte.vitest.ts etc.), which move with the components; this
 * node-project suite exists so the "zero behavior change" claim is checked
 * in environments that cannot launch a browser.
 */
import { describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRawSnippet, type Component } from 'svelte';
import { render } from 'svelte/server';

/**
 * Resolve a shared component from its post-move home (packages/ui-kit) or
 * its pre-move home (packages/ui/src/lib/components). Follows the file
 * rather than pinning one path — same convention as
 * endpoints-state-hygiene.vitest.ts.
 */
function resolveComponentPath(rel: string): string {
  const candidates = [
    // Post-move: packages/ui-kit/src/lib/components/<rel>
    new URL(`../../../ui-kit/src/lib/components/${rel}`, import.meta.url),
    // Pre-move: packages/ui/src/lib/components/<rel>
    new URL(`./components/${rel}`, import.meta.url)
  ];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return path;
  }
  throw new Error(`shared component ${rel} found in neither ui-kit nor ui`);
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
