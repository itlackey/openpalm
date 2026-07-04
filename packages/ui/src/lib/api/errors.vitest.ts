import { describe, expect, test } from 'vitest';
import { isAuthError, toMessage } from './errors.js';

describe('isAuthError', () => {
  test('true for 401 and 403 (reads e.status)', () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ status: 403 })).toBe(true);
    expect(isAuthError(Object.assign(new Error('Sign-in required.'), { status: 401 }))).toBe(true);
  });

  test('false for other statuses and for status-less values', () => {
    expect(isAuthError({ status: 500 })).toBe(false);
    expect(isAuthError(new Error('boom'))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError('401')).toBe(false);
  });
});

describe('toMessage', () => {
  test('returns the Error message when given an Error', () => {
    expect(toMessage(new Error('nope'), 'fallback')).toBe('nope');
  });

  test('returns the fallback for non-Error values', () => {
    expect(toMessage('str', 'fallback')).toBe('fallback');
    expect(toMessage(null, 'fallback')).toBe('fallback');
    expect(toMessage({ message: 'x' }, 'fallback')).toBe('fallback');
  });
});
