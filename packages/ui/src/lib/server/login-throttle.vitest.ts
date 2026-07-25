/**
 * Failed-login throttling.
 *
 * The behaviour under test is the compensating control for publishing the UI
 * beyond loopback: the login wall is the only credential boundary, and it was
 * previously unthrottled.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  _resetLoginThrottle,
  backoffMsForFailures,
  checkLoginThrottle,
  clearLoginAttempts,
  recordLoginFailure,
} from './login-throttle.js';

const IP = '192.168.1.50';
const T0 = 1_700_000_000_000;

beforeEach(() => {
  _resetLoginThrottle();
});

describe('backoffMsForFailures', () => {
  test('the first four failures are free — a fat-fingered password is not punished', () => {
    for (let n = 1; n <= 4; n += 1) expect(backoffMsForFailures(n)).toBe(0);
  });

  test('the fifth failure arms backoff, and it doubles from there', () => {
    expect(backoffMsForFailures(5)).toBe(1_000);
    expect(backoffMsForFailures(6)).toBe(2_000);
    expect(backoffMsForFailures(7)).toBe(4_000);
    expect(backoffMsForFailures(8)).toBe(8_000);
  });

  test('caps at 15 minutes rather than growing without bound', () => {
    expect(backoffMsForFailures(100)).toBe(15 * 60 * 1_000);
    expect(backoffMsForFailures(1_000)).toBe(15 * 60 * 1_000);
  });
});

describe('checkLoginThrottle', () => {
  test('an unseen client is allowed', () => {
    expect(checkLoginThrottle(IP, T0)).toEqual({ allowed: true });
  });

  test('stays allowed through the free attempts', () => {
    for (let n = 0; n < 4; n += 1) recordLoginFailure(IP, T0);
    expect(checkLoginThrottle(IP, T0)).toEqual({ allowed: true });
  });

  test('blocks once backoff engages, and reports a Retry-After', () => {
    for (let n = 0; n < 5; n += 1) recordLoginFailure(IP, T0);
    const verdict = checkLoginThrottle(IP, T0);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.retryAfterSec).toBe(1);
  });

  test('Retry-After is never 0 — that would read as "retry immediately"', () => {
    for (let n = 0; n < 5; n += 1) recordLoginFailure(IP, T0);
    // 999ms into a 1000ms block: ceil() keeps it at 1, never 0.
    const verdict = checkLoginThrottle(IP, T0 + 999);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  test('allows again once the window elapses', () => {
    for (let n = 0; n < 5; n += 1) recordLoginFailure(IP, T0);
    expect(checkLoginThrottle(IP, T0 + 1_001)).toEqual({ allowed: true });
  });

  test('escalates on repeated failure rather than resetting to the base delay', () => {
    for (let n = 0; n < 6; n += 1) recordLoginFailure(IP, T0);
    const verdict = checkLoginThrottle(IP, T0);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.retryAfterSec).toBe(2);
  });

  test('clients are tracked independently — one attacker cannot lock out the household', () => {
    for (let n = 0; n < 10; n += 1) recordLoginFailure('10.0.0.9', T0);
    expect(checkLoginThrottle('10.0.0.9', T0).allowed).toBe(false);
    expect(checkLoginThrottle(IP, T0)).toEqual({ allowed: true });
  });
});

describe('clearLoginAttempts', () => {
  test('a successful sign-in wipes the counter', () => {
    for (let n = 0; n < 5; n += 1) recordLoginFailure(IP, T0);
    expect(checkLoginThrottle(IP, T0).allowed).toBe(false);
    clearLoginAttempts(IP);
    expect(checkLoginThrottle(IP, T0)).toEqual({ allowed: true });
  });
});

describe('idle reset', () => {
  test('an old failure count does not resume hours later', () => {
    for (let n = 0; n < 9; n += 1) recordLoginFailure(IP, T0);
    const muchLater = T0 + 60 * 60 * 1_000;
    expect(checkLoginThrottle(IP, muchLater)).toEqual({ allowed: true });
    // The next failure starts a fresh count, so it is free rather than
    // resuming the previous escalation.
    recordLoginFailure(IP, muchLater);
    expect(checkLoginThrottle(IP, muchLater)).toEqual({ allowed: true });
  });
});
