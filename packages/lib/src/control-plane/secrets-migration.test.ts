import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateDir, privateSecretsDir, secretsDir } from './home.js';
import { DELEGATED_SECRET_NAMES } from './secrets-files.js';
import { migrateDelegatedSecretsToPrivateDir } from './secrets-migration.js';

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-secrets-migration-'));
  homes.push(home);
  return home;
}

function writeSource(home: string, name: string, content: string): string {
  mkdirSync(secretsDir(home), { recursive: true });
  const path = join(secretsDir(home), name);
  writeFileSync(path, content);
  return path;
}

function writeDestination(home: string, name: string, content: string, mode = 0o600): string {
  mkdirSync(privateSecretsDir(home), { recursive: true });
  const path = join(privateSecretsDir(home), name);
  writeFileSync(path, content, { mode });
  return path;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('migrateDelegatedSecretsToPrivateDir', () => {
  it('creates and hardens both private directories on every run', () => {
    const home = makeHome();
    migrateDelegatedSecretsToPrivateDir(home);
    chmodSync(privateDir(home), 0o755);
    chmodSync(privateSecretsDir(home), 0o755);

    migrateDelegatedSecretsToPrivateDir(home);

    expect(statSync(privateDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(privateSecretsDir(home)).mode & 0o777).toBe(0o700);
  });

  it('copies each delegated secret durably, verifies it, then removes only the source pathname', () => {
    const home = makeHome();
    for (const name of DELEGATED_SECRET_NAMES) writeSource(home, name, `value-${name}\n`);

    const result = migrateDelegatedSecretsToPrivateDir(home);

    expect(result.migrated.sort()).toEqual([...DELEGATED_SECRET_NAMES].sort());
    for (const name of DELEGATED_SECRET_NAMES) {
      expect(existsSync(join(secretsDir(home), name))).toBe(false);
      const destination = join(privateSecretsDir(home), name);
      expect(readFileSync(destination, 'utf8')).toBe(`value-${name}\n`);
      expect(statSync(destination).mode & 0o777).toBe(0o600);
    }
  });

  it('leaves provider auth and other non-delegated knowledge secrets untouched', () => {
    const home = makeHome();
    writeSource(home, 'auth.json', '{"provider":"value"}\n');
    writeSource(home, 'op_guardian_admin_token', 'delegated\n');

    migrateDelegatedSecretsToPrivateDir(home);

    expect(readFileSync(join(secretsDir(home), 'auth.json'), 'utf8')).toBe(
      '{"provider":"value"}\n',
    );
    expect(existsSync(join(privateSecretsDir(home), 'auth.json'))).toBe(false);
  });

  it('is retry-idempotent for already moved and identical partially moved copies', () => {
    const home = makeHome();
    const [alreadyMoved, partial] = [...DELEGATED_SECRET_NAMES];
    writeDestination(home, alreadyMoved, 'already\n');
    writeSource(home, partial, 'partial\n');
    writeDestination(home, partial, 'partial\n');

    const first = migrateDelegatedSecretsToPrivateDir(home);
    const second = migrateDelegatedSecretsToPrivateDir(home);

    expect(first.alreadyMigrated).toContain(alreadyMoved);
    expect(first.migrated).toContain(partial);
    expect(second.alreadyMigrated).toEqual(expect.arrayContaining([alreadyMoved, partial]));
    expect(second.migrated).toEqual([]);
    expect(existsSync(join(secretsDir(home), partial))).toBe(false);
  });

  it('preserves and reports differing destination and source bytes', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    const source = writeSource(home, name, 'source\n');
    const destination = writeDestination(home, name, 'destination\n');

    const result = migrateDelegatedSecretsToPrivateDir(home);

    expect(result.skippedMismatch).toEqual([name]);
    expect(readFileSync(source, 'utf8')).toBe('source\n');
    expect(readFileSync(destination, 'utf8')).toBe('destination\n');
  });

  it('enforces 0600 for already-migrated, identical, and mismatched destinations', () => {
    const home = makeHome();
    mkdirSync(privateDir(home), { mode: 0o755 });
    mkdirSync(privateSecretsDir(home), { mode: 0o755 });
    const [alreadyMoved, identical, mismatch] = [...DELEGATED_SECRET_NAMES];
    const destinations = [
      writeDestination(home, alreadyMoved, 'already\n', 0o644),
      writeDestination(home, identical, 'same\n', 0o644),
      writeDestination(home, mismatch, 'new\n', 0o644),
    ];
    writeSource(home, identical, 'same\n');
    writeSource(home, mismatch, 'old\n');

    const result = migrateDelegatedSecretsToPrivateDir(home);

    expect(result.alreadyMigrated).toContain(alreadyMoved);
    expect(result.migrated).toContain(identical);
    expect(result.skippedMismatch).toContain(mismatch);
    for (const path of destinations) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(privateDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(privateSecretsDir(home)).mode & 0o777).toBe(0o700);
  });

  it('leaves an interrupted partial fallback destination for explicit mismatch recovery on retry', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    const source = writeSource(home, name, 'complete-source\n');
    const destination = join(privateSecretsDir(home), name);
    const originalLink = fs.linkSync;
    const originalCopy = fs.copyFileSync;
    let copyFlags: number | undefined;
    const linkSpy = spyOn(fs, 'linkSync').mockImplementation(((from, to) => {
      if (String(to) === destination) {
        throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' });
      }
      return originalLink(from, to);
    }) as typeof fs.linkSync);
    const copySpy = spyOn(fs, 'copyFileSync').mockImplementation(((from, to, flags) => {
      if (String(to) === destination) {
        copyFlags = flags;
        writeFileSync(destination, 'partial', { mode: 0o600 });
        throw Object.assign(new Error('interrupted copy'), { code: 'EIO' });
      }
      return originalCopy(from, to, flags);
    }) as typeof fs.copyFileSync);
    try {
      expect(() => migrateDelegatedSecretsToPrivateDir(home)).toThrow('interrupted copy');
    } finally {
      linkSpy.mockRestore();
      copySpy.mockRestore();
    }

    expect(copyFlags).toBe(fs.constants.COPYFILE_EXCL);
    expect(readFileSync(source, 'utf8')).toBe('complete-source\n');
    expect(readFileSync(destination, 'utf8')).toBe('partial');

    const retry = migrateDelegatedSecretsToPrivateDir(home);
    expect(retry.skippedMismatch).toEqual([name]);
    expect(readFileSync(source, 'utf8')).toBe('complete-source\n');
    expect(readFileSync(destination, 'utf8')).toBe('partial');
  });

  it('retries past a stale partial staging file', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    const source = writeSource(home, name, 'complete-source\n');
    const originalFsync = fs.fsyncSync;
    let failed = false;
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor) => {
      if (!failed && !fs.fstatSync(descriptor).isDirectory()) {
        failed = true;
        throw Object.assign(new Error('staging interrupted'), { code: 'EIO' });
      }
      return originalFsync(descriptor);
    }) as typeof fs.fsyncSync);
    try {
      expect(() => migrateDelegatedSecretsToPrivateDir(home)).toThrow('staging interrupted');
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(existsSync(source)).toBe(true);
    expect(
      fs.readdirSync(privateSecretsDir(home)).some((entry) => entry.endsWith('.tmp')),
    ).toBe(true);

    expect(migrateDelegatedSecretsToPrivateDir(home).migrated).toContain(name);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(privateSecretsDir(home), name), 'utf8')).toBe('complete-source\n');
  });

  it('preserves the source when staged secret bytes change before publication', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    const source = writeSource(home, name, 'source-secret\n');
    const destination = join(privateSecretsDir(home), name);
    const originalOpen = fs.openSync;
    let changed = false;
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((path, flags, mode) => {
      if (
        !changed &&
        String(path).includes(`.openpalm-secret-${name}-`) &&
        typeof flags === 'number' &&
        (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0
      ) {
        changed = true;
        writeFileSync(String(path), 'staged-edit\n');
      }
      return originalOpen(path, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(() => migrateDelegatedSecretsToPrivateDir(home)).toThrow(
        'changed during migration',
      );
    } finally {
      openSpy.mockRestore();
    }

    expect(changed).toBe(true);
    expect(readFileSync(source, 'utf8')).toBe('source-secret\n');
    expect(existsSync(destination)).toBe(false);
  });

  it('preserves the source when the destination inode changes after its fsync', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    const source = writeSource(home, name, 'durable-source\n');
    const destination = join(privateSecretsDir(home), name);
    const displaced = `${destination}.displaced`;
    const originalFsync = fs.fsyncSync;
    let fileSyncs = 0;
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor) => {
      const result = originalFsync(descriptor);
      if (!fs.fstatSync(descriptor).isDirectory() && ++fileSyncs === 2) {
        fs.renameSync(destination, displaced);
        writeFileSync(destination, 'durable-source\n', { mode: 0o600 });
      }
      return result;
    }) as typeof fs.fsyncSync);
    try {
      expect(() => migrateDelegatedSecretsToPrivateDir(home)).toThrow(
        'changed during durability sync',
      );
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(fileSyncs).toBe(2);
    expect(readFileSync(source, 'utf8')).toBe('durable-source\n');
    expect(readFileSync(destination, 'utf8')).toBe('durable-source\n');
    expect(readFileSync(displaced, 'utf8')).toBe('durable-source\n');
  });

  it('finishes an interrupted hard-link publication without accepting unrelated hard links', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    const source = writeSource(home, name, 'published\n');
    mkdirSync(privateSecretsDir(home), { recursive: true });
    const temporary = join(privateSecretsDir(home), `.openpalm-secret-${name}-stale.tmp`);
    const destination = join(privateSecretsDir(home), name);
    writeFileSync(temporary, 'published\n', { mode: 0o600 });
    linkSync(temporary, destination);
    expect(statSync(destination).nlink).toBe(2);

    expect(migrateDelegatedSecretsToPrivateDir(home).migrated).toContain(name);
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(source)).toBe(false);
    expect(statSync(destination).nlink).toBe(1);
    expect(readFileSync(destination, 'utf8')).toBe('published\n');
  });

  it('uses the exclusive copy fallback when hard-link publication is unsupported', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    writeSource(home, name, 'portable\n');
    const destination = join(privateSecretsDir(home), name);
    const originalLink = fs.linkSync;
    const linkSpy = spyOn(fs, 'linkSync').mockImplementation(((from, to) => {
      if (String(to) === destination) {
        throw Object.assign(new Error('hard links unsupported'), { code: 'EPERM' });
      }
      return originalLink(from, to);
    }) as typeof fs.linkSync);
    try {
      expect(migrateDelegatedSecretsToPrivateDir(home).migrated).toContain(name);
    } finally {
      linkSpy.mockRestore();
    }
    expect(readFileSync(destination, 'utf8')).toBe('portable\n');
  });

  it('rejects static symlink and hardlink secret inputs without following or unlinking them', () => {
    const [symlinkName, hardlinkName] = [...DELEGATED_SECRET_NAMES];

    const symlinkHome = makeHome();
    const outside = join(symlinkHome, 'outside-secret');
    writeFileSync(outside, 'outside\n');
    mkdirSync(secretsDir(symlinkHome), { recursive: true });
    symlinkSync(outside, join(secretsDir(symlinkHome), symlinkName));
    expect(() => migrateDelegatedSecretsToPrivateDir(symlinkHome)).toThrow(
      'without symbolic or hard links',
    );
    expect(readFileSync(outside, 'utf8')).toBe('outside\n');

    const hardlinkHome = makeHome();
    const hardlinkOutside = join(hardlinkHome, 'outside-hardlink');
    writeFileSync(hardlinkOutside, 'outside\n');
    mkdirSync(privateSecretsDir(hardlinkHome), { recursive: true });
    linkSync(hardlinkOutside, join(privateSecretsDir(hardlinkHome), hardlinkName));
    expect(() => migrateDelegatedSecretsToPrivateDir(hardlinkHome)).toThrow(
      'without symbolic or hard links',
    );
    expect(statSync(hardlinkOutside).nlink).toBe(2);
  });

  it('rejects non-regular source and destination entries', () => {
    const [sourceName, destinationName] = [...DELEGATED_SECRET_NAMES];
    const sourceHome = makeHome();
    mkdirSync(join(secretsDir(sourceHome), sourceName), { recursive: true });
    expect(() => migrateDelegatedSecretsToPrivateDir(sourceHome)).toThrow(
      'must be a regular file',
    );

    const destinationHome = makeHome();
    mkdirSync(join(privateSecretsDir(destinationHome), destinationName), { recursive: true });
    expect(() => migrateDelegatedSecretsToPrivateDir(destinationHome)).toThrow(
      'must be a regular file',
    );
  });

  it('rejects a symlinked private ownership boundary', () => {
    const home = makeHome();
    const outside = join(home, 'outside-private');
    mkdirSync(outside);
    symlinkSync(outside, privateDir(home), 'dir');

    expect(() => migrateDelegatedSecretsToPrivateDir(home)).toThrow(
      'Private directory must be a real directory',
    );
    expect(lstatSync(privateDir(home)).isSymbolicLink()).toBe(true);
  });

  it('fsyncs files only through writable descriptors', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    writeSource(home, name, 'writable-sync\n');
    const flagsByDescriptor = new Map<number, number>();
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((path, flags, mode) => {
      const descriptor = originalOpen(path, flags, mode);
      if (typeof flags === 'number') flagsByDescriptor.set(descriptor, flags);
      return descriptor;
    }) as typeof fs.openSync);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor) => {
      if (!fs.fstatSync(descriptor).isDirectory()) {
        expect(
          (flagsByDescriptor.get(descriptor) ?? 0) & (fs.constants.O_WRONLY | fs.constants.O_RDWR),
        ).not.toBe(0);
      }
      return originalFsync(descriptor);
    }) as typeof fs.fsyncSync);
    try {
      migrateDelegatedSecretsToPrivateDir(home);
    } finally {
      openSpy.mockRestore();
      fsyncSpy.mockRestore();
    }
  });

  it('requires directory fsync on Linux and tolerates known unsupported errors elsewhere', () => {
    const home = makeHome();
    const [name] = [...DELEGATED_SECRET_NAMES];
    const source = writeSource(home, name, 'durable\n');
    const originalFsync = fs.fsyncSync;
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        throw Object.assign(new Error('directory sync unsupported'), { code: 'EPERM' });
      }
      return originalFsync(descriptor);
    }) as typeof fs.fsyncSync);
    try {
      if (process.platform === 'linux') {
        expect(() => migrateDelegatedSecretsToPrivateDir(home)).toThrow(
          'directory sync unsupported',
        );
        expect(existsSync(source)).toBe(true);
      } else {
        expect(() => migrateDelegatedSecretsToPrivateDir(home)).not.toThrow();
        expect(existsSync(source)).toBe(false);
      }
    } finally {
      fsyncSpy.mockRestore();
    }
  });
});
