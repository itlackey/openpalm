/**
 * #648 secondary — `openpalm backups --help` told the operator to run
 * `openpalm backups list`, which did not exist (backup.ts's
 * describeBackupSpaceShortfall references it too). This covers the `list`
 * subcommand added to close that gap, and the pre-rollback capping the
 * `prune` help text now describes accurately (#657 pt.2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import backupsCommand from './backups.ts';

let homeDir: string;
let previousHome: string | undefined;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-backups-cli-'));
  previousHome = process.env.OP_HOME;
  process.env.OP_HOME = homeDir;
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.log = originalLog;
  if (previousHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = previousHome;
  rmSync(homeDir, { recursive: true, force: true });
});

function makeBackup(name: string): void {
  const dir = join(homeDir, 'data', 'backups', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marker.txt'), 'x'.repeat(10));
}

describe('openpalm backups list', () => {
  it('reports no backups when none exist', async () => {
    // @ts-expect-error citty's subCommands typing is loose enough that a
    // direct `.run({ args: {} })` call is the simplest correct invocation.
    await backupsCommand.subCommands.list.run({ args: {} });
    expect(logs).toEqual(['No backups found.']);
  });

  it('lists existing snapshots with size and creation time', async () => {
    makeBackup('2020-01-01T00-00-00-000Z');
    // @ts-expect-error see above
    await backupsCommand.subCommands.list.run({ args: {} });
    expect(logs.some((line) => line.includes('2020-01-01T00-00-00-000Z'))).toBe(true);
    expect(logs.some((line) => line.includes('1 backup(s)'))).toBe(true);
  });
});

describe('openpalm backups prune --help text (#657 pt.2 accuracy)', () => {
  it('no longer claims -pre-rollback is never pruned by anything', () => {
    const description = String(backupsCommand.subCommands?.prune?.meta?.description ?? '');
    expect(description).not.toContain('Recovery snapshots (-pre-rollback, -pre-update) are never pruned');
    expect(description).toContain('rollback` keeps the newest 3 of its own `-pre-rollback` snapshots');
    expect(description).toContain('-pre-update');
  });
});
