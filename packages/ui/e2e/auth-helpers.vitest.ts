import { describe, expect, test } from 'vitest';
import { extractSessionCookie } from './auth-helpers.js';

describe('E2E session cookie extraction', () => {
  test('parses host-admin and assistant-container cookie scopes', () => {
    expect(extractSessionCookie('op_session=admin-token; HttpOnly; Path=/')).toEqual({
      name: 'op_session',
      value: 'admin-token',
    });
    expect(
      extractSessionCookie('op_session_assistant=assistant-token; HttpOnly; SameSite=Lax; Path=/'),
    ).toEqual({
      name: 'op_session_assistant',
      value: 'assistant-token',
    });
  });

  test('rejects responses without a recognized session cookie', () => {
    expect(() => extractSessionCookie('other=value; Path=/')).toThrow('Could not parse session cookie');
  });
});
