/**
 * 0.1 — writeSystemEnv and writeVaultFile must go through the shared
 * writeFileAtomic helper (tmp file + rename) so an interrupted write can
 * never tear the target file: readers see either the fully-old content or
 * the fully-new content, never a partial write.
 *
 * We simulate "interrupted mid-write" by forcing the rename step (the last,
 * atomic step of writeFileAtomic) to throw. If the writer is truly atomic,
 * the throw happens before the target path is ever touched, so its original
 * content survives untouched. If the writer instead writes directly to the
 * target path (the pre-fix behavior), renameSync is never called at all and
 * the operation "succeeds" without going through the safe path — which this
 * test also catches, because it asserts the call throws.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as nodeFs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemEnv } from './config-persistence.js';
import { writeFileAtomic } from './fs-atomic.js';
import { createState } from './lifecycle.js';
import { patchSecretsEnvFile } from './secrets.js';

let homeDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-fs-atomic-'));
  savedHome = process.env.OP_HOME;
  process.env.OP_HOME = homeDir;
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(homeDir, 'state'), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('0.1 atomic writes — torn-write protection', () => {
  it('syncs staged content, the published target, and its parent in that order', () => {
    const path = join(homeDir, 'state', 'durable.txt');
    const originalFsync = nodeFs.fsyncSync;
    const originalRename = nodeFs.renameSync;
    const events: string[] = [];
    const fsyncSpy = spyOn(nodeFs, 'fsyncSync').mockImplementation(((descriptor) => {
      events.push(nodeFs.fstatSync(descriptor).isDirectory() ? 'directory-sync' : 'file-sync');
      return originalFsync(descriptor);
    }) as typeof nodeFs.fsyncSync);
    const renameSpy = spyOn(nodeFs, 'renameSync').mockImplementation(((from, to) => {
      if (String(to) === path) events.push('publish');
      return originalRename(from, to);
    }) as typeof nodeFs.renameSync);
    try {
      writeFileAtomic(path, 'durable\n', 0o600);
    } finally {
      fsyncSpy.mockRestore();
      renameSpy.mockRestore();
    }

    expect(events).toEqual(['file-sync', 'publish', 'directory-sync']);
    expect(readFileSync(path, 'utf8')).toBe('durable\n');
  });

	it('rejects a static parent symlink before creating anything outside the boundary', () => {
    const outside = mkdtempSync(join(tmpdir(), 'openpalm-fs-atomic-outside-'));
    try {
      const linkedParent = join(homeDir, 'linked-state');
      symlinkSync(outside, linkedParent, 'dir');

      expect(() => writeFileAtomic(join(linkedParent, 'escaped.txt'), 'nope')).toThrow(
        'must contain only real directories',
      );
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
		}
	});

	it('rejects a non-directory parent component before mkdir, staging, or rename', () => {
		const blockedParent = join(homeDir, 'state', 'not-a-directory');
		writeFileSync(blockedParent, 'blocked');
		const mkdirSpy = spyOn(nodeFs, 'mkdirSync');
		const openSpy = spyOn(nodeFs, 'openSync');
		const renameSpy = spyOn(nodeFs, 'renameSync');
		try {
			expect(() => writeFileAtomic(join(blockedParent, 'target.txt'), 'nope')).toThrow(
				'must contain only real directories'
			);
			expect(mkdirSpy).not.toHaveBeenCalled();
			expect(openSpy).not.toHaveBeenCalled();
			expect(renameSpy).not.toHaveBeenCalled();
		} finally {
			mkdirSpy.mockRestore();
			openSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});

  it('rejects a parent replacement detected before publication', () => {
    const parent = join(homeDir, 'state');
    const heldParent = join(homeDir, 'held-state');
    const path = join(parent, 'replaced.txt');
    const originalFsync = nodeFs.fsyncSync;
    let replaced = false;
    const fsyncSpy = spyOn(nodeFs, 'fsyncSync').mockImplementation(((descriptor) => {
      originalFsync(descriptor);
      if (!replaced && !nodeFs.fstatSync(descriptor).isDirectory()) {
        replaced = true;
        nodeFs.renameSync(parent, heldParent);
        nodeFs.mkdirSync(parent);
      }
    }) as typeof nodeFs.fsyncSync);
    try {
      expect(() => writeFileAtomic(path, 'never published')).toThrow(
        'parent changed during publication',
      );
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(replaced).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects a staging inode that gains another hard link before publication', () => {
    const directory = join(homeDir, 'state');
    const path = join(directory, 'linked-stage.txt');
    const extraLink = join(directory, 'captured-stage.txt');
    const originalFsync = nodeFs.fsyncSync;
    let linked = false;
    const fsyncSpy = spyOn(nodeFs, 'fsyncSync').mockImplementation(((descriptor) => {
      const result = originalFsync(descriptor);
      if (!linked && !nodeFs.fstatSync(descriptor).isDirectory()) {
        const temporary = readdirSync(directory).find((entry) => entry.endsWith('.tmp'));
        if (temporary === undefined) throw new Error('missing atomic staging file');
        linked = true;
        nodeFs.linkSync(join(directory, temporary), extraLink);
      }
      return result;
    }) as typeof nodeFs.fsyncSync);
    try {
      expect(() => writeFileAtomic(path, 'never published')).toThrow(
        'staging path changed during publication',
      );
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(linked).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(extraLink, 'utf8')).toBe('never published');
  });

  it('tolerates only known unsupported directory fsync errors off Linux', () => {
    const path = join(homeDir, 'state', 'portable.txt');
    const originalFsync = nodeFs.fsyncSync;
    const fsyncSpy = spyOn(nodeFs, 'fsyncSync').mockImplementation(((descriptor) => {
      if (nodeFs.fstatSync(descriptor).isDirectory()) {
        throw Object.assign(new Error('directory fsync unsupported'), { code: 'EPERM' });
      }
      return originalFsync(descriptor);
    }) as typeof nodeFs.fsyncSync);
    try {
      if (process.platform === 'linux') {
        expect(() => writeFileAtomic(path, 'durable')).toThrow('directory fsync unsupported');
      } else {
        expect(() => writeFileAtomic(path, 'durable')).not.toThrow();
      }
    } finally {
      fsyncSpy.mockRestore();
    }
    expect(readFileSync(path, 'utf8')).toBe('durable');
  });

  it('writeSystemEnv leaves stack.env fully intact when the atomic rename fails', () => {
    const state = createState();
    const path = join(homeDir, 'state', 'stack.env');
    writeFileSync(path, `OP_HOME=${homeDir}\nOP_SETUP_COMPLETE=true\nOP_LOG_LEVEL=info\n`);

    const spy = spyOn(nodeFs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated crash before rename lands');
    });
    try {
      expect(() => writeSystemEnv(state)).toThrow();
    } finally {
      spy.mockRestore();
    }

    // Old content must be fully intact — never partially overwritten.
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('OP_SETUP_COMPLETE=true');
    expect(content).toContain('OP_LOG_LEVEL=info');
    expect(nodeFs.readdirSync(join(homeDir, 'state'))).toEqual(['stack.env']);
  });

  it('writeVaultFile (via patchSecretsEnvFile) leaves stack.env fully intact when the atomic rename fails', () => {
    const path = join(homeDir, 'state', 'stack.env');
    writeFileSync(path, 'OP_SETUP_COMPLETE=false\nOP_LOG_LEVEL=debug\n');

    const spy = spyOn(nodeFs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated crash before rename lands');
    });
    try {
      expect(() => patchSecretsEnvFile(homeDir, { OP_ASSISTANT_VERSION: 'latest' })).toThrow();
    } finally {
      spy.mockRestore();
    }

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('OP_SETUP_COMPLETE=false');
    expect(content).toContain('OP_LOG_LEVEL=debug');
  });
});
