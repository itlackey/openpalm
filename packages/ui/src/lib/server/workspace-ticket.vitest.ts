/**
 * The workspace ticket: the credential that carries an OpenPalm session to a
 * workspace published on a different HOSTNAME.
 *
 * Three properties make it safe to put a credential in a URL, and each is
 * pinned here: it is the same signed token everything else verifies (no second
 * way to authenticate), it dies in a minute, and it is spent on first use — so
 * the copy left in a reverse proxy's access log is not one anyone can redeem.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { _clearSessions, validateSession } from './session-store.js';
import {
  mintWorkspaceTicket,
  redeemWorkspaceTicket,
  WORKSPACE_TICKET_PARAM,
  WORKSPACE_TICKET_TTL_MS,
} from './workspace-ticket.js';
import { WORKSPACE_TICKET_PARAM as CLIENT_SIDE_PARAM } from '$lib/workspace-ticket-param.js';

beforeEach(() => {
  process.env.OP_UI_LOGIN_PASSWORD = 'test-secret';
  _clearSessions();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OP_UI_LOGIN_PASSWORD;
});

describe('a ticket is the session, briefly', () => {
  test('a fresh ticket validates as an ordinary session token', () => {
    // Deliberately not a second token format: the listener redeems it with the
    // same validateSession every route uses, so there is one thing to get right.
    const ticket = mintWorkspaceTicket();
    expect(validateSession(ticket)).toBe(true);
  });

  test('it expires in a minute, not in a fortnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const ticket = mintWorkspaceTicket();
    vi.setSystemTime(Date.now() + WORKSPACE_TICKET_TTL_MS + 1);
    expect(redeemWorkspaceTicket(ticket)).toBe(false);
  });

  test('a password change invalidates it, like every other session', () => {
    const ticket = mintWorkspaceTicket();
    process.env.OP_UI_LOGIN_PASSWORD = 'rotated';
    expect(redeemWorkspaceTicket(ticket)).toBe(false);
  });
});

describe('a ticket is spent on first use', () => {
  test('the first redemption succeeds and the second does not', () => {
    const ticket = mintWorkspaceTicket();
    expect(redeemWorkspaceTicket(ticket)).toBe(true);
    expect(redeemWorkspaceTicket(ticket)).toBe(false);
  });

  test('spending one leaves others alone', () => {
    const first = mintWorkspaceTicket();
    // Same-millisecond mints would collide (the token is a signed expiry), so
    // move time to guarantee two distinct tickets.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);
    const second = mintWorkspaceTicket();
    expect(first).not.toBe(second);

    expect(redeemWorkspaceTicket(first)).toBe(true);
    expect(redeemWorkspaceTicket(second)).toBe(true);
  });

  test('garbage is refused without ceremony', () => {
    expect(redeemWorkspaceTicket('')).toBe(false);
    expect(redeemWorkspaceTicket('not-a-ticket')).toBe(false);
    expect(redeemWorkspaceTicket(`${Date.now() + 60_000}.deadbeef`)).toBe(false);
  });
});

describe('both sides spell the parameter the same way', () => {
  test('the server module re-exports the browser-side constant', () => {
    // The page attaching the ticket cannot import a $lib/server module, so the
    // name lives in one client-safe file that both read. A literal spelled
    // twice would authenticate nothing and report no error.
    expect(WORKSPACE_TICKET_PARAM).toBe(CLIENT_SIDE_PARAM);
  });
});
