import { describe, expect, test } from 'vitest';

import { isLocalAssistantUrl } from './assistant-endpoint.js';

describe('isLocalAssistantUrl', () => {
  test('returns true for loopback assistant urls', () => {
    expect(isLocalAssistantUrl('http://127.0.0.1:3800')).toBe(true);
    expect(isLocalAssistantUrl('http://localhost:3800')).toBe(true);
    expect(isLocalAssistantUrl('http://host.docker.internal:3800')).toBe(true);
  });

  test('returns false for remote assistant urls', () => {
    expect(isLocalAssistantUrl('https://assistant.example.com')).toBe(false);
  });
});
