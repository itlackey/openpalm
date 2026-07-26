/**
 * A relative `instructions` entry resolves from the session directory (/work),
 * not from the config that declared it, so it silently loads nothing. Both
 * services shipped that way.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKELETON = resolve(import.meta.dir, '../../../..', 'packages/skeleton');

function instructions(service: string): string[] {
  const raw = readFileSync(join(SKELETON, 'system', service, 'opencode.jsonc'), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')).instructions ?? [];
}

for (const service of ['assistant', 'guardian']) {
  describe(service, () => {
    test('every instructions entry is absolute and exists', () => {
      const entries = instructions(service);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.startsWith('/') || entry.startsWith('~/'), `${entry} is relative`).toBe(true);
        // Map container paths back to their skeleton source.
        const file = entry.startsWith('/etc/opencode/')
          ? join(SKELETON, 'system', service, entry.slice('/etc/opencode/'.length))
          : entry.startsWith('~/.config/opencode/')
            ? join(SKELETON, 'config', service, entry.slice('~/.config/opencode/'.length))
            : null;
        if (!file) continue;
        expect(existsSync(file), `${entry} does not exist`).toBe(true);
      }
    });
  });
}

/**
 * Permission patterns must actually match the resource OpenCode asserts.
 * `wildcard.ts`: regex-escape, `*`->`.*`, `?`->`.`, anchored `^...$`; a trailing
 * " *" becomes "( .*)?" so the argument is optional. `/` is not special.
 */
function matches(pattern: string, input: string): boolean {
  let e = pattern.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (e.endsWith(' .*')) e = `${e.slice(0, -3)}( .*)?`;
  return new RegExp(`^${e}$`, 's').test(input);
}

describe('assistant permission patterns are live, not decorative', () => {
  const perm = JSON.parse(
    readFileSync(join(SKELETON, 'system/assistant/opencode.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  ).permission;

  test('external_directory matches the "<dir>/*" resource the tools assert', () => {
    // Bare "/stash" compiled to ^/stash$ and never matched. Regression guard.
    for (const dir of ['/stash', '/work', '/tmp']) {
      const asserted = `${dir}/sub/*`;
      expect(
        Object.keys(perm.external_directory).some((p) => matches(p, asserted)),
        `nothing in external_directory matches ${asserted}`,
      ).toBe(true);
    }
  });

  test('sudo and destructive rm prompt; a bare root wipe is denied', () => {
    const decide = (cmd: string) =>
      Object.entries(perm.bash).filter(([p]) => matches(p, cmd)).pop()?.[1];
    expect(decide('sudo apt install jq')).toBe('ask');  // "sudo" alone was ^sudo$ — dead
    expect(decide('rm -rf /stash/tmp')).toBe('ask');
    expect(decide('rm -rf /')).toBe('deny');
    expect(decide('ls -la')).toBe('allow');
  });
});
