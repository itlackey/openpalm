import { defineCommand } from 'citty';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveVaultDir } from '@openpalm/lib';
import { parseEnvFile, isSensitiveEnvKey } from '@openpalm/lib';

/**
 * `openpalm scan` — list sensitive env keys that carry a non-empty value
 * in the live vault env files. Replaces the varlock-based scanner; the
 * canonical inventory now lives in `akm vault` and the operator-managed
 * `.env` files. Exits non-zero only on filesystem errors, never on the
 * mere presence of secrets (that is the expected state).
 *
 * Output formats:
 *   --format json    (default) machine-readable JSON
 *                    { "files": [{ "path": "...", "keys": [{ "name": "...", "set": true }] }] }
 *   --format human   grouped, one line per key:
 *                    # /path/to/file.env
 *                      KEY_NAME    set
 */
export default defineCommand({
  meta: {
    name: 'scan',
    description: 'List vault env keys whose name matches the secret pattern (_TOKEN/_SECRET/_KEY/_PASSWORD/_HMAC)',
  },
  args: {
    format: {
      type: 'string',
      description: 'Output format: json (default) or human',
      default: 'json',
    },
  },
  async run({ args }) {
    const format = String(args.format ?? 'json').toLowerCase();
    if (format !== 'json' && format !== 'human') {
      console.error(`Unknown --format value: ${args.format}. Expected 'json' or 'human'.`);
      process.exit(2);
    }

    const vaultDir = resolveVaultDir();
    const targets = [
      join(vaultDir, 'stack', 'stack.env'),
      join(vaultDir, 'stack', 'guardian.env'),
      join(vaultDir, 'user', 'user.env'),
    ];

    type FileResult = { path: string; keys: Array<{ name: string; set: boolean }> };
    const results: FileResult[] = [];

    for (const path of targets) {
      if (!existsSync(path)) continue;
      const parsed = parseEnvFile(path);
      const sensitive = Object.keys(parsed)
        .filter((k) => isSensitiveEnvKey(k))
        .sort();
      if (sensitive.length === 0) continue;
      results.push({
        path,
        keys: sensitive.map((name) => ({
          name,
          set: typeof parsed[name] === 'string' && parsed[name].length > 0,
        })),
      });
    }

    if (format === 'json') {
      console.log(JSON.stringify({ files: results }));
    } else {
      if (results.length === 0) {
        console.log('No vault env files found. Run `openpalm install` first.');
      } else {
        for (const file of results) {
          console.log(`# ${file.path}`);
          for (const key of file.keys) {
            console.log(`  ${key.name}\t${key.set ? 'set' : 'empty'}`);
          }
        }
      }
    }
    process.exit(0);
  },
});
