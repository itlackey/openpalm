import { describe, expect, it } from 'bun:test';
import { errMessage } from './errors.js';

describe('errMessage', () => {
  it('returns the message of an Error', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a string value unchanged', () => {
    expect(errMessage('plain string')).toBe('plain string');
  });

  it('coerces a non-Error object with String()', () => {
    expect(errMessage({ code: 42 })).toBe('[object Object]');
    expect(errMessage(null)).toBe('null');
    expect(errMessage(undefined)).toBe('undefined');
    expect(errMessage(123)).toBe('123');
  });

  it('preserves subclass Error messages', () => {
    class CustomError extends Error {}
    expect(errMessage(new CustomError('custom'))).toBe('custom');
  });
});
