import { describe, expect, test } from 'vitest';
import { resolveSessionTitle } from './session-title.js';
import { formatDateTime } from './format-date.js';

describe('resolveSessionTitle', () => {
  test('formats the OpenCode default "New session - <ISO>" title', () => {
    const iso = '2026-06-07T02:36:02.631Z';
    expect(resolveSessionTitle(`New session - ${iso}`)).toBe(formatDateTime(Date.parse(iso)));
  });

  test('passes through a real model-named title', () => {
    expect(resolveSessionTitle('Greeting and check-in')).toBe('Greeting and check-in');
  });

  test('passes through a channel-derived title', () => {
    expect(resolveSessionTitle('discord/discord:thread:1513042110071312585')).toBe(
      'discord/discord:thread:1513042110071312585',
    );
  });

  test('empty / nullish → Untitled session', () => {
    expect(resolveSessionTitle('')).toBe('Untitled session');
    expect(resolveSessionTitle('   ')).toBe('Untitled session');
    expect(resolveSessionTitle(null)).toBe('Untitled session');
    expect(resolveSessionTitle(undefined)).toBe('Untitled session');
  });

  test('a title that merely mentions "New session" without the ISO passes through', () => {
    expect(resolveSessionTitle('New session ideas')).toBe('New session ideas');
  });

  test('an unparseable timestamp in the default shape passes through verbatim', () => {
    expect(resolveSessionTitle('New session - not-a-date')).toBe('New session - not-a-date');
  });
});
