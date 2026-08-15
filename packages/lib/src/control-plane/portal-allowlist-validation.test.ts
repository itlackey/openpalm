/**
 * A portal with no allowlist is the one state in which it cannot do its job at
 * all — portal-sdk `checkPermissions` answers `no_allowlist_configured` and
 * denies every caller — and it is also the state that looks healthiest from
 * outside: the container runs, its port is open, its compose healthcheck is a
 * bare TCP connect, and `openpalm status` shows it up. These pin the one place
 * that says so out loud.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPortalAllowlists } from './validate.js';

let home = '';

function seedStackEnv(lines: string[]): void {
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'stack.env'), `${lines.join('\n')}\n`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'op-portal-allowlist-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('checkPortalAllowlists', () => {
  test('warns when an enabled portal would deny everyone', () => {
    seedStackEnv(['OP_ENABLED_ADDONS=discord']);
    const warnings = checkPortalAllowlists(home);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('discord');
    expect(warnings[0]).toContain('DENY every user');
    // Actionable: names the keys to set and the explicit allow-all opt-in.
    expect(warnings[0]).toContain('DISCORD_ALLOWED_GUILDS');
    expect(warnings[0]).toContain('DISCORD_ALLOWED_USERS="*"');
  });

  test('stays silent when any one scope is configured', () => {
    for (const key of ['DISCORD_ALLOWED_USERS', 'DISCORD_ALLOWED_GUILDS', 'DISCORD_ALLOWED_ROLES']) {
      seedStackEnv(['OP_ENABLED_ADDONS=discord', `${key}=123`]);
      expect(checkPortalAllowlists(home), key).toEqual([]);
    }
  });

  test('treats the explicit allow-all sentinel as configured', () => {
    seedStackEnv(['OP_ENABLED_ADDONS=discord', 'DISCORD_ALLOWED_USERS=*']);
    expect(checkPortalAllowlists(home)).toEqual([]);
  });

  test('a value of only separators and blanks is not an allowlist', () => {
    // parseIdList drops empty entries, so this reaches the adapter as an empty
    // set — reading it as "configured" would suppress the warning for a portal
    // that still denies everyone.
    seedStackEnv(['OP_ENABLED_ADDONS=discord', 'DISCORD_ALLOWED_USERS= , ,']);
    expect(checkPortalAllowlists(home)).toHaveLength(1);
  });

  test('covers slack on its own scopes', () => {
    seedStackEnv(['OP_ENABLED_ADDONS=slack']);
    expect(checkPortalAllowlists(home)[0]).toContain('SLACK_ALLOWED_CHANNELS');

    seedStackEnv(['OP_ENABLED_ADDONS=slack', 'SLACK_ALLOWED_CHANNELS=C123']);
    expect(checkPortalAllowlists(home)).toEqual([]);
  });

  test('reports each unusable portal once', () => {
    seedStackEnv(['OP_ENABLED_ADDONS=discord,slack']);
    expect(checkPortalAllowlists(home)).toHaveLength(2);
  });

  test('says nothing about a portal that is not enabled', () => {
    // A disabled portal's empty allowlist is not a problem — there is nothing
    // deployed to deny anyone.
    seedStackEnv(['OP_ENABLED_ADDONS=voice']);
    expect(checkPortalAllowlists(home)).toEqual([]);
  });

  test('says nothing for a home with no stack env at all', () => {
    expect(checkPortalAllowlists(home)).toEqual([]);
  });
});
