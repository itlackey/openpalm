import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const PAGE_PATH = fileURLToPath(new URL('./+page.svelte', import.meta.url));

function pageSource(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

describe('device Voice settings route', () => {
  test('owns the client Voice panel and states that settings span assistants', () => {
    const source = pageSource();
    expect(source).toMatch(/VoiceClientSettings/);
    expect(source).toMatch(/<h1>Voice input &amp; playback<\/h1>/);
    expect(source).toMatch(/across (?:all )?assistants/i);
  });

  test('resolves reload-safe return context and preserves it across peer settings pages', () => {
    const source = pageSource();
    expect(source).toMatch(/page\.url\.searchParams\.get\(\s*['"]returnTo['"]\s*\)/);
    expect(source).toMatch(/resolveReturnToPath/);
    expect(source).toMatch(/buildChatPath/);
    expect(source).toMatch(/buildAdvancedPath/);
    expect(source).toMatch(/endpointsService\.activeId/);
  });

  test('uses plain destination chrome followed by the shared device-settings subnav', () => {
    const source = pageSource();

    expect(source).toMatch(
      /<Navbar brandHref=\{chatReturnHref\} showUtilities=\{false\} \/>[\s\S]*<DeviceSettingsNav active="voice" \{chatReturnHref\} \/>[\s\S]*<main/,
    );
    expect(source).not.toMatch(/ChatNavbar/);
    expect(source).not.toMatch(/<nav class="page-nav"/);
  });

  test('links the contextual secondary action precisely to the host Voice add-on', () => {
    const source = pageSource();
    expect(source).toMatch(/hasCapability\(\s*['"]host:stack:read['"]\s*\)/);
    expect(source).toMatch(/`\$\{resolve\(\s*['"]\/host['"]\s*\)\}\?tab=addons&addon=voice`/);
    expect(source).toMatch(/Manage host Voice/);
    expect(source).toMatch(
      /\{#if hasCapability\(\s*['"]host:stack:read['"]\s*\)\}[\s\S]*?href=\{hostSettingsHref\}/,
    );
  });

  test('gives the contextual action a 44px target', () => {
    const source = pageSource();
    expect(source).toMatch(/\.host-settings-link\s*\{[\s\S]*?min-height:\s*44px/);
  });
});
