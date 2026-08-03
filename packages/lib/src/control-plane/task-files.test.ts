import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeTaskFilename,
  listTaskFiles,
  readTaskFile,
  readTaskFileSnapshot,
  replaceTaskFileForHomeMigration,
  resolveTasksDir,
  taskIdFromTaskFilename,
  writeTaskFile,
} from './task-files.js';

const HISTORICAL = "version: 2\nschedule: '0 8 * * *'\nenabled: false\nprompt: old\n";
const CURRENT = "version: 2\nschedule: '0 8 * * *'\nenabled: false\ncommand: new\n";

let homeDir: string;

function tasksDir(): string {
  return join(homeDir, 'knowledge', 'tasks');
}

function taskPath(): string {
  return join(tasksDir(), 'assistant-daily-briefing.yml');
}

function seedTask(content: string, mode = 0o600): void {
  mkdirSync(tasksDir(), { recursive: true });
  writeFileSync(taskPath(), content, { mode });
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-task-migration-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('daily briefing home migration', () => {
  it('atomically replaces only an exact historical byte sequence', () => {
    seedTask(HISTORICAL, 0o640);

    expect(
      replaceTaskFileForHomeMigration(
        homeDir,
        'assistant-daily-briefing.yml',
        new Set([HISTORICAL]),
        CURRENT,
      ),
    ).toBe(true);

    expect(readFileSync(taskPath(), 'utf8')).toBe(CURRENT);
    expect(statSync(taskPath()).mode & 0o777).toBe(0o640);
    expect(readdirSync(tasksDir())).toEqual(['assistant-daily-briefing.yml']);
  });

  for (const [label, content] of [
    ['one-byte edit', HISTORICAL.replace('prompt', 'Prompt')],
    ['line-ending edit', HISTORICAL.replaceAll('\n', '\r\n')],
    ['enabled task', HISTORICAL.replace('false', 'true')],
    ['current task', CURRENT],
  ] as const) {
    it(`preserves ${label} byte-for-byte`, () => {
      seedTask(content);

      expect(
        replaceTaskFileForHomeMigration(
          homeDir,
          'assistant-daily-briefing.yml',
          new Set([HISTORICAL]),
          CURRENT,
        ),
      ).toBe(false);
      expect(readFileSync(taskPath())).toEqual(Buffer.from(content));
    });
  }

  it('does not create an absent task or task directory', () => {
    mkdirSync(join(homeDir, 'knowledge'));

    expect(
      replaceTaskFileForHomeMigration(
        homeDir,
        'assistant-daily-briefing.yml',
        new Set([HISTORICAL]),
        CURRENT,
      ),
    ).toBe(false);
    expect(existsSync(tasksDir())).toBe(false);
  });

  it('preserves the original when staging fsync fails', () => {
    seedTask(HISTORICAL);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    try {
      expect(() =>
        replaceTaskFileForHomeMigration(
          homeDir,
          'assistant-daily-briefing.yml',
          new Set([HISTORICAL]),
          CURRENT,
        ),
      ).toThrow('disk full');
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(readFileSync(taskPath(), 'utf8')).toBe(HISTORICAL);
    expect(readdirSync(tasksDir())).toEqual(['assistant-daily-briefing.yml']);
  });

  it('preserves the original when staged replacement bytes change before publication', () => {
    seedTask(HISTORICAL);
    const originalOpen = fs.openSync;
    let changed = false;
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((path, flags, mode) => {
      if (
        !changed &&
        String(path).includes('.openpalm-task-') &&
        typeof flags === 'number' &&
        (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0
      ) {
        changed = true;
        writeFileSync(String(path), 'staged edit\n');
      }
      return originalOpen(path, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(() =>
        replaceTaskFileForHomeMigration(
          homeDir,
          'assistant-daily-briefing.yml',
          new Set([HISTORICAL]),
          CURRENT,
        ),
      ).toThrow('changed since it was loaded');
    } finally {
      openSpy.mockRestore();
    }

    expect(changed).toBe(true);
    expect(readFileSync(taskPath(), 'utf8')).toBe(HISTORICAL);
    expect(readdirSync(tasksDir())).toEqual(['assistant-daily-briefing.yml']);
  });

  it('aborts when the live task path stops naming the validated directory', () => {
    seedTask(HISTORICAL);
    const originalDirectory = tasksDir();
    const heldDirectory = `${originalDirectory}-held`;
    const originalFsync = fs.fsyncSync;
    let replaced = false;
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor) => {
      originalFsync(descriptor);
      if (!replaced && !fs.fstatSync(descriptor).isDirectory()) {
        replaced = true;
        fs.renameSync(originalDirectory, heldDirectory);
        fs.mkdirSync(originalDirectory);
        writeFileSync(taskPath(), 'live replacement\n');
      }
    }) as typeof fs.fsyncSync);
    try {
      expect(() =>
        replaceTaskFileForHomeMigration(
          homeDir,
          'assistant-daily-briefing.yml',
          new Set([HISTORICAL]),
          CURRENT,
        ),
      ).toThrow('Task directory changed during migration');
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(replaced).toBe(true);
    expect(readFileSync(join(heldDirectory, 'assistant-daily-briefing.yml'), 'utf8')).toBe(
      HISTORICAL,
    );
    expect(readFileSync(taskPath(), 'utf8')).toBe('live replacement\n');
  });

  it('postverifies the published task after syncing its directory', () => {
    seedTask(HISTORICAL);
    const originalFsync = fs.fsyncSync;
    let edited = false;
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor) => {
      const result = originalFsync(descriptor);
      if (!edited && fs.fstatSync(descriptor).isDirectory()) {
        edited = true;
        writeFileSync(taskPath(), 'concurrent edit\n');
      }
      return result;
    }) as typeof fs.fsyncSync);
    try {
      expect(() =>
        replaceTaskFileForHomeMigration(
          homeDir,
          'assistant-daily-briefing.yml',
          new Set([HISTORICAL]),
          CURRENT,
        ),
      ).toThrow('changed since it was loaded');
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(edited).toBe(true);
    expect(readFileSync(taskPath(), 'utf8')).toBe('concurrent edit\n');
  });

  it('skips symbolic and hard-linked task files without changing their targets', () => {
    mkdirSync(tasksDir(), { recursive: true });
    const outside = join(homeDir, 'outside.yml');
    writeFileSync(outside, HISTORICAL);
    symlinkSync(outside, taskPath());
    expect(
      replaceTaskFileForHomeMigration(
        homeDir,
        'assistant-daily-briefing.yml',
        new Set([HISTORICAL]),
        CURRENT,
      ),
    ).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe(HISTORICAL);

    rmSync(taskPath());
    linkSync(outside, taskPath());
    expect(
      replaceTaskFileForHomeMigration(
        homeDir,
        'assistant-daily-briefing.yml',
        new Set([HISTORICAL]),
        CURRENT,
      ),
    ).toBe(false);
    expect(statSync(outside).nlink).toBe(2);
  });

  it('rejects a symlinked task directory', () => {
    mkdirSync(join(homeDir, 'knowledge'));
    const outside = join(homeDir, 'outside-tasks');
    mkdirSync(outside);
    writeFileSync(join(outside, 'assistant-daily-briefing.yml'), HISTORICAL);
    symlinkSync(outside, tasksDir(), 'dir');

    expect(() =>
      replaceTaskFileForHomeMigration(
        homeDir,
        'assistant-daily-briefing.yml',
        new Set([HISTORICAL]),
        CURRENT,
      ),
    ).toThrow('Task directory must be a real directory');
    expect(lstatSync(tasksDir()).isSymbolicLink()).toBe(true);
  });
});

describe('legacy task exports', () => {
  it('lists and reads safe task files for the retained legacy parser', () => {
    const stashDir = join(homeDir, 'knowledge');
    mkdirSync(stashDir);
    const directory = resolveTasksDir(stashDir);
    writeFileSync(join(directory, 'daily.yml'), 'opaque: value\n');
    writeFileSync(join(directory, 'notes.txt'), 'ignored');

    expect(listTaskFiles(stashDir).map((file) => file.name)).toEqual(['daily.yml']);
    expect(readTaskFile(stashDir, 'daily.yml')).toBe('opaque: value\n');
  });

  it('rejects a stale revision-aware write without clobbering a user edit', () => {
    const stashDir = join(homeDir, 'knowledge');
    mkdirSync(stashDir);
    const path = join(resolveTasksDir(stashDir), 'daily.yml');
    writeFileSync(path, 'historical\n');
    const snapshot = readTaskFileSnapshot(stashDir, 'daily.yml');
    if (snapshot === null) throw new Error('missing test snapshot');
    writeFileSync(path, 'user edit\n');

    expect(() => writeTaskFile(stashDir, 'daily.yml', 'replacement\n', snapshot.revision)).toThrow(
      'changed since it was loaded',
    );
    expect(readFileSync(path, 'utf8')).toBe('user edit\n');
  });

  it('retains the shared portable filename mapping', () => {
    expect(() => assertSafeTaskFilename('foo..yml')).not.toThrow();
    expect(taskIdFromTaskFilename('foo..yml')).toBe('foo.');
    for (const name of ['../escape.yml', 'CON.yml', 'LPT³.yml']) {
      expect(() => assertSafeTaskFilename(name)).toThrow();
    }
  });
});
