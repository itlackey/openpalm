import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { hostReturnTo, hostTabFromUrl, hostUrlForTab } from './navigation.js';

const HOST_PAGE_PATH = fileURLToPath(new URL('./+page.svelte', import.meta.url));

describe('host tab URLs', () => {
  test('initializes every admin section from a direct link', () => {
    const tabs = [
      'overview',
      'addons',
      'automations',
      'connections',
      'secrets',
      'akm',
      'assistant',
      'host-sharing',
      'activity',
      'containers',
      'logs',
      'updates',
      'recovery',
    ] as const;

    for (const tab of tabs) {
      expect(hostTabFromUrl(new URL(`http://localhost/host?tab=${tab}`))).toBe(tab);
    }
  });

  test('keeps the diagnostics deep-link alias and safely defaults unknown tabs', () => {
    expect(hostTabFromUrl(new URL('http://localhost/host?tab=diagnostics'))).toBe('containers');
    expect(hostTabFromUrl(new URL('http://localhost/host?tab=unknown'))).toBe('overview');
    expect(hostTabFromUrl(new URL('http://localhost/host'))).toBe('overview');
  });

  test('builds distinct history URLs without dropping return or addon context', () => {
    const original = new URL(
      'http://localhost/host?returnTo=%2Fchat%3Fsession%3Dsession-1&addon=voice',
    );
    const addonsEntry = hostUrlForTab(original, 'addons');
    const activityEntry = hostUrlForTab(addonsEntry, 'activity');

    expect(addonsEntry.searchParams.get('tab')).toBe('addons');
    expect(activityEntry.searchParams.get('tab')).toBe('activity');
    expect(activityEntry.searchParams.get('returnTo')).toBe('/chat?session=session-1');
    expect(activityEntry.searchParams.get('addon')).toBe('voice');
    expect(original.searchParams.has('tab')).toBe(false);

    // Browser Back/Forward restores a prior URL; deriving from that URL must
    // restore the corresponding section without any separate tab state.
    expect(hostTabFromUrl(addonsEntry)).toBe('addons');
    expect(hostTabFromUrl(activityEntry)).toBe('activity');
  });
});

describe('host chat return', () => {
  test('accepts root-relative and absolute same-origin return destinations', () => {
    expect(
      hostReturnTo(
        new URL('http://localhost/host?returnTo=%2Fchat%3Fsession%3Dsession-1%23latest'),
      ),
    ).toBe('/chat?session=session-1#latest');
    expect(
      hostReturnTo(
        new URL(
          'http://localhost/host?returnTo=http%3A%2F%2Flocalhost%2Fadvanced%3Fsession%3Dsession-1',
        ),
      ),
    ).toBe('/advanced?session=session-1');
  });

  test('rejects cross-origin and non-navigation return destinations', () => {
    expect(hostReturnTo(new URL('http://localhost/host'))).toBeUndefined();
    expect(
      hostReturnTo(new URL('http://localhost/host?returnTo=https%3A%2F%2Fevil.example%2Fchat')),
    ).toBeUndefined();
    expect(
      hostReturnTo(new URL('http://localhost/host?returnTo=%2F%2Fevil.example%2Fchat')),
    ).toBeUndefined();
    expect(
      hostReturnTo(new URL('http://localhost/host?returnTo=javascript%3Aalert%281%29')),
    ).toBeUndefined();
  });
});

describe('host page history wiring', () => {
  test('derives from page.url and shallow-pushes tab selections', () => {
    const source = readFileSync(HOST_PAGE_PATH, 'utf-8');

    expect(source).toMatch(/\$state\(hostTabFromUrl\(page\.url\)\)/);
    expect(source).toMatch(/const nextUrl = hostUrlForTab\(currentHostUrl, tab\)/);
    expect(source).toMatch(/pushState\(nextUrl, \{\}\)/);
    expect(source).toMatch(/<svelte:window onpopstate=\{handleHistoryChange\}\s*\/>/);
    expect(source).toMatch(/new URL\(window\.location\.href\)/);
  });

  test('passes a validated return destination and Voice deep-link to child components', () => {
    const source = readFileSync(HOST_PAGE_PATH, 'utf-8');

    expect(source).toMatch(/\$state\(hostReturnTo\(page\.url\)\)/);
    expect(source).toMatch(/<Navbar brandHref=\{resolvedChatReturnHref\} showUtilities=\{false\}>/);
    expect(source).toMatch(/conversationHref=\{resolvedChatReturnHref\}/);
    expect(source).toMatch(/focusAddon=\{focusAddon\}/);
  });

  test('offers routine logs only for schedulable task filenames', () => {
    const source = readFileSync(HOST_PAGE_PATH, 'utf-8');

    expect(source).toContain('.filter((automation) => automation.schedulable)');
    expect(source).toContain('.map((automation) => automation.fileName)');
  });
});
