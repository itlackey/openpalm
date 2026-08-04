/**
 * The chat thread is not where you end a session.
 *
 * Sign out used to be a button absolutely positioned over the conversation
 * content, rendered unconditionally — so it also appeared in processes with no
 * login password, where logging out lands on a /login that answers 503. It now
 * lives in Settings → General behind `data.signedIn`. This is a cheap
 * source-shape guard that it does not creep back onto the chat surface.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const chatSource = readFileSync(
  fileURLToPath(new URL('./+page.svelte', import.meta.url)),
  'utf8',
);
const settingsSource = readFileSync(
  fileURLToPath(new URL('../connections/+page.svelte', import.meta.url)),
  'utf8',
);

describe('sign-out placement', () => {
  test('the chat surface carries no sign-out control', () => {
    expect(chatSource).not.toContain('/api/auth/logout');
    expect(chatSource).not.toContain('s-signout');
  });

  test('settings owns it, gated on an actual session', () => {
    expect(settingsSource).toContain('/api/auth/logout');
    expect(settingsSource).toContain('data.signedIn');
  });
});
