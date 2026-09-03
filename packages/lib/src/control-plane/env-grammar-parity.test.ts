/**
 * #628 — the app and `docker compose --env-file` must read an app-written env
 * file IDENTICALLY.
 *
 * This is the test the two reverted attempts did not have. Both were checked
 * against dotenv alone, and dotenv is not the reader that matters: Compose
 * parses the same file with its own rules, and the shape the writer used for
 * awkward values was one the two disagreed about. Written for a Windows path,
 * the app read `C:\\Users\\op\\` back while Compose read `C:\Users\op\` — same
 * bytes, two values, no error from either side.
 *
 * So every case here goes through a real `docker compose config`. Skipped
 * when docker is unavailable; CI's gates job has it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeEnvContent,
  parseEnvContent,
  quoteComposeEnvValue,
  unquoteComposeEnvValue,
  UnrepresentableEnvValueError,
} from './env.js';

const dockerAvailable = (() => {
  try {
    return Bun.spawnSync(['docker', 'compose', 'version']).exitCode === 0;
  } catch {
    return false;
  }
})();

/** What `docker compose` itself resolves the value to. */
function composeReads(envContent: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'op-env-parity-'));
  try {
    writeFileSync(join(dir, 'stack.env'), envContent);
    writeFileSync(
      join(dir, 'compose.yml'),
      'services:\n  probe:\n    image: busybox\n    environment:\n      PROBE: ${K}\n',
    );
    const result = Bun.spawnSync([
      'docker', 'compose', '-f', join(dir, 'compose.yml'), '--env-file', join(dir, 'stack.env'), 'config',
    ]);
    if (result.exitCode !== 0) return null;
    const match = new TextDecoder().decode(result.stdout).match(/^\s*PROBE:\s?(.*)$/m);
    if (!match) return null;
    // Undo compose's own OUTPUT encoding, which is not part of what it read:
    // it quotes a YAML scalar that needs it (double for specials, single for
    // leading/trailing space) and writes a literal `$` as `$$`.
    const rendered = match[1].trim();
    const unquoted =
      rendered.startsWith('"') && rendered.endsWith('"')
        ? (JSON.parse(rendered) as string)
        : rendered.startsWith("'") && rendered.endsWith("'")
          ? rendered.slice(1, -1).replaceAll("''", "'")
          : rendered;
    return unquoted.replaceAll('$$', '$');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every value an OP_HOME actually holds — paths, ports, flags, tags, ids,
// addon lists — plus the awkward ones that motivated the old third shape.
const ROUND_TRIPPABLE = [
  'bare',
  '0.13.3',
  '/home/op/.openpalm',
  '/Volumes/Bob Drive/openpalm',
  'C:\\Users\\op\\openpalm',
  'discord,slack',
  '127.0.0.1',
  'true',
  'latest-cpu',
  'has#hash',
  'has$dollar',
  'has"double',
  ' padded ',
  'a=b=c',
];

describe('#628 env grammar: the app and docker compose read the same bytes the same way', () => {
  for (const value of ROUND_TRIPPABLE) {
    test(`round-trips ${JSON.stringify(value)}`, () => {
      const content = mergeEnvContent('', { K: value });

      // The app's own reader.
      expect(parseEnvContent(content).K).toBe(value);

      // The two-line reader a non-JS consumer can implement, stated in
      // quoteEnvValue's docblock. If this diverges, the docblock is a lie.
      const raw = content.split('\n').find((line) => line.startsWith('K='))!.slice(2);
      expect(unquoteComposeEnvValue(raw)).toBe(value);

      if (!dockerAvailable) return;
      expect(composeReads(content)).toBe(value);
    });
  }

  // The refusals. Compose fails --env-file WHOLE-FILE, so a value written in a
  // shape it rejects takes down every compose command on that home — the
  // refusal has to happen at the write, where the key can be named.
  test('refuses a value ending in a backslash, which compose rejects file-wide', () => {
    expect(() => quoteComposeEnvValue('C:\\Users\\op\\', 'OP_HOME')).toThrow(UnrepresentableEnvValueError);
    expect(() => quoteComposeEnvValue('C:\\Users\\op\\', 'OP_HOME')).toThrow(/OP_HOME/);
  });

  test('refuses a value containing a single quote', () => {
    expect(() => quoteComposeEnvValue("Bob's stack", 'OP_OWNER_NAME')).toThrow(UnrepresentableEnvValueError);
  });

  test('refuses a value containing a line break', () => {
    expect(() => quoteComposeEnvValue('two\nlines', 'OP_ANYTHING')).toThrow(UnrepresentableEnvValueError);
  });

  // Proof the refusals are not theoretical: this is the exact file the OLD
  // writer produced for a Windows path, and compose will not read it at all.
  test.skipIf(!dockerAvailable)('the shape that is now refused really does break compose', () => {
    expect(composeReads("K='C:\\Users\\op\\'\n")).toBeNull();
  });

  // The disagreement that motivated deleting the third shape.
  test.skipIf(!dockerAvailable)('the deleted double-quoted shape is one the two readers disagree about', () => {
    const legacy = 'K="C:\\\\Users\\\\op\\\\"\n';
    expect(parseEnvContent(legacy).K).toBe('C:\\\\Users\\\\op\\\\');
    expect(composeReads(legacy)).toBe('C:\\Users\\op\\');
    // Same bytes, two values. Nothing the writer can do about a file it did
    // not write — but it no longer PRODUCES this shape.
    expect(parseEnvContent(legacy).K).not.toBe(composeReads(legacy));
  });

  // #628 defect 5: the writer edited the first occurrence, every reader takes
  // the last, so the write was silently read back as the stale value.
  test('a duplicated key is written where the readers actually look', () => {
    const content = mergeEnvContent('K=first\nOTHER=x\nK=second\n', { K: 'NEW' });

    expect(parseEnvContent(content).K).toBe('NEW');
    expect(content).toContain('OTHER=x');
    expect(content).not.toContain('K=first');
    if (dockerAvailable) expect(composeReads(content)).toBe('NEW');
  });
});
