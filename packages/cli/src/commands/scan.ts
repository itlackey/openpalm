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
 */
export default defineCommand({
  meta: {
    name: 'scan',
    description: 'List vault env keys whose name matches the secret pattern (_TOKEN/_SECRET/_KEY/_PASSWORD)',
  },
  async run() {
    const vaultDir = resolveVaultDir();
    const targets = [
      join(vaultDir, 'stack', 'stack.env'),
      join(vaultDir, 'stack', 'guardian.env'),
      join(vaultDir, 'user', 'user.env'),
    ];

    let scanned = 0;
    for (const path of targets) {
      if (!existsSync(path)) continue;
      const parsed = parseEnvFile(path);
      const sensitive = Object.keys(parsed)
        .filter((k) => isSensitiveEnvKey(k))
        .sort();
      if (sensitive.length === 0) continue;
      scanned++;
      console.log(`# ${path}`);
      for (const key of sensitive) {
        const set = parsed[key] && parsed[key].length > 0 ? 'set' : 'empty';
        console.log(`  ${key}\t${set}`);
      }
    }
    if (scanned === 0) {
      console.log('No vault env files found. Run `openpalm install` first.');
    }
    process.exit(0);
  },
});
