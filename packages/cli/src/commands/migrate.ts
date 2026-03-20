/**
 * CLI `migrate` command.
 *
 * Handles the v0.9.x → v0.10.0 transition:
 *   1. Detect legacy XDG layout and env vars
 *   2. Create the new ~/.openpalm/ directory structure
 *   3. Move directories from old XDG locations to new layout
 *   4. Split env files (secrets.env + stack.env → vault/user/user.env + vault/stack/stack.env)
 *   5. Convert legacy channel overlays to component instances
 *   6. Print summary
 *   7. Preserve old directories until --cleanup is passed
 *
 * All non-destructive by default — old directories are never deleted
 * unless the user passes --cleanup.
 */
import { defineCommand } from 'citty';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  resolveOpenPalmHome,
  ensureHomeDirs,
  detectLegacyLayout,
  hasLegacyEnvVars,
  parseEnvContent,
  isValidInstanceId,
} from '@openpalm/lib';

// ── Env Splitting Rules ─────────────────────────────────────────────────

/** Keys from secrets.env / stack.env that go to vault/user/user.env */
const USER_ENV_KEYS = new Set([
  // LLM provider API keys
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'GOOGLE_API_KEY',
  // Provider URLs and model config
  'OPENAI_BASE_URL',
  'SYSTEM_LLM_PROVIDER',
  'SYSTEM_LLM_MODEL',
  'SYSTEM_LLM_BASE_URL',
  'SYSTEM_LLM_API_KEY',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_MODEL',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_MODEL_DIMS',
  // Memory user
  'OPENMEMORY_USER_ID',
  'MEMORY_USER_ID',
]);

/** Keys from secrets.env / stack.env that go to vault/stack/stack.env */
const SYSTEM_ENV_KEYS = new Set([
  // Admin and auth tokens
  'ADMIN_TOKEN',
  'OP_ADMIN_TOKEN',
  'MEMORY_AUTH_TOKEN',
  'OPENCODE_SERVER_PASSWORD',
  // System paths and config
  'OP_HOME',
  'OP_UID',
  'OP_GID',
  // Image tags
  'OP_IMAGE_TAG',
  'OP_IMAGE_NAMESPACE',
  // HMAC and channel secrets
  'CHANNEL_HMAC_SECRET',
  'OP_DOCKER_SOCK',
]);

/** Keys that start with these prefixes go to system.env */
const SYSTEM_ENV_PREFIXES = [
  'OP_IMAGE_',
  'CHANNEL_',
];

/**
 * Categorize an env key as user or system.
 */
function categorizeEnvKey(key: string): 'user' | 'system' {
  if (USER_ENV_KEYS.has(key)) return 'user';
  if (SYSTEM_ENV_KEYS.has(key)) return 'system';
  for (const prefix of SYSTEM_ENV_PREFIXES) {
    if (key.startsWith(prefix)) return 'system';
  }
  // Default: user env for unknown keys (safer — user can move them later)
  return 'user';
}

/**
 * Rename ADMIN_TOKEN to OP_ADMIN_TOKEN and OPENMEMORY_USER_ID to MEMORY_USER_ID.
 */
function normalizeEnvKey(key: string): string {
  if (key === 'ADMIN_TOKEN') return 'OP_ADMIN_TOKEN';
  if (key === 'OPENMEMORY_USER_ID') return 'MEMORY_USER_ID';
  return key;
}

// ── Migration Steps ─────────────────────────────────────────────────────

/**
 * Copy a directory tree from src to dest. If dest already exists, merges
 * without overwriting existing files.
 */
async function copyDirSafe(src: string, dest: string, summary: string[]): Promise<void> {
  if (!existsSync(src)) return;

  mkdirSync(dest, { recursive: true });
  await cp(src, dest, { recursive: true, force: false, errorOnExist: false });
  summary.push(`  ${src} -> ${dest}`);
}

/**
 * Copy a single file without overwriting.
 */
function copyFileSafe(src: string, dest: string, summary: string[]): void {
  if (!existsSync(src)) return;
  if (existsSync(dest)) {
    summary.push(`  ${src} -> ${dest} (skipped, already exists)`);
    return;
  }
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(src, dest);
  summary.push(`  ${src} -> ${dest}`);
}

/**
 * Split secrets.env + stack.env into vault/user/user.env + vault/stack/stack.env.
 */
function splitEnvFiles(
  configHome: string,
  dataHome: string,
  openpalmHome: string,
  summary: string[],
): void {
  const secretsPath = join(configHome, 'secrets.env');
  const stackPath = join(dataHome, 'stack.env');
  // Also check STATE_HOME for stack.env (some installs put it there)
  const altStackPath = join(configHome, 'stack.env');

  mkdirSync(join(openpalmHome, 'vault', 'user'), { recursive: true });
  mkdirSync(join(openpalmHome, 'vault', 'stack'), { recursive: true });
  const userEnvPath = join(openpalmHome, 'vault', 'user', 'user.env');
  const systemEnvPath = join(openpalmHome, 'vault', 'stack', 'stack.env');

  // Collect all env vars from both source files
  const allVars: Record<string, string> = {};

  for (const path of [secretsPath, stackPath, altStackPath]) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf-8');
    const parsed = parseEnvContent(content);
    Object.assign(allVars, parsed);
  }

  if (Object.keys(allVars).length === 0) {
    summary.push('  No env files to split.');
    return;
  }

  // Split into user and system buckets
  const userVars: Record<string, string> = {};
  const systemVars: Record<string, string> = {};

  for (const [rawKey, value] of Object.entries(allVars)) {
    const category = categorizeEnvKey(rawKey);
    const key = normalizeEnvKey(rawKey);
    if (category === 'user') {
      userVars[key] = value;
    } else {
      systemVars[key] = value;
    }
  }

  // Set OP_HOME in system.env
  systemVars['OP_HOME'] = openpalmHome;

  // Write user.env (only if not already present)
  if (!existsSync(userEnvPath)) {
    const userLines = Object.entries(userVars).map(([k, v]) => `${k}=${v}`);
    writeFileSync(userEnvPath, userLines.join('\n') + '\n');
    summary.push(`  vault/user/user.env created (${Object.keys(userVars).length} keys)`);
  } else {
    summary.push('  vault/user/user.env already exists (skipped)');
  }

  // Write stack.env (only if not already present)
  if (!existsSync(systemEnvPath)) {
    const systemLines = Object.entries(systemVars).map(([k, v]) => `${k}=${v}`);
    writeFileSync(systemEnvPath, systemLines.join('\n') + '\n');
    summary.push(`  vault/stack/stack.env created (${Object.keys(systemVars).length} keys)`);
  } else {
    summary.push('  vault/stack/stack.env already exists (skipped)');
  }
}

/**
 * Convert legacy channel overlay .yml files to component instance directories.
 * Each .yml file in channels/ becomes a directory under data/components/.
 */
function convertChannelOverlays(
  configHome: string,
  openpalmHome: string,
  summary: string[],
): void {
  const channelsDir = join(configHome, 'channels');
  if (!existsSync(channelsDir)) {
    summary.push('  No legacy channels/ directory found.');
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(channelsDir);
  } catch {
    summary.push('  Could not read channels/ directory.');
    return;
  }

  const ymlFiles = entries.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  if (ymlFiles.length === 0) {
    summary.push('  No channel overlay files found in channels/.');
    return;
  }

  const componentsDir = join(openpalmHome, 'data', 'components');
  mkdirSync(componentsDir, { recursive: true });

  for (const file of ymlFiles) {
    const name = basename(file, file.endsWith('.yaml') ? '.yaml' : '.yml');

    if (!isValidInstanceId(name)) {
      summary.push(`  channels/${file} -> skipped (invalid instance ID: "${name}")`);
      continue;
    }

    const instanceDir = join(componentsDir, name);

    if (existsSync(instanceDir)) {
      summary.push(`  channels/${file} -> data/components/${name}/ (skipped, already exists)`);
      continue;
    }

    mkdirSync(instanceDir, { recursive: true });
    mkdirSync(join(instanceDir, 'data'), { recursive: true });

    // Copy the .yml as compose.yml
    copyFileSync(join(channelsDir, file), join(instanceDir, 'compose.yml'));

    // Write identity .env
    const envLines = [
      '# Instance identity — migrated from legacy channel overlay',
      `INSTANCE_ID=${name}`,
      `INSTANCE_DIR=${instanceDir}`,
      '',
    ];
    writeFileSync(join(instanceDir, '.env'), envLines.join('\n'));

    summary.push(`  channels/${file} -> data/components/${name}/`);
  }

  // Write enabled.json with all migrated instances
  const enabledPath = join(componentsDir, 'enabled.json');
  if (!existsSync(enabledPath)) {
    const instances = ymlFiles
      .map((f) => {
        const name = basename(f, f.endsWith('.yaml') ? '.yaml' : '.yml');
        return { id: name, component: name, enabled: true };
      })
      .filter((inst) => isValidInstanceId(inst.id));
    writeFileSync(enabledPath, JSON.stringify({ instances }, null, 2));
    summary.push(`  enabled.json created (${instances.length} instances)`);
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────

function cleanupLegacyDirs(summary: string[]): void {
  const home = homedir();
  const legacyDirs = [
    join(home, '.config', 'openpalm'),
    join(home, '.local', 'share', 'openpalm'),
    join(home, '.local', 'state', 'openpalm'),
  ];

  // Also check custom env var paths
  for (const envVar of ['OP_CONFIG_HOME', 'OP_DATA_HOME', 'OP_STATE_HOME']) {
    const val = process.env[envVar];
    if (val && existsSync(val) && !legacyDirs.includes(val)) {
      legacyDirs.push(val);
    }
  }

  let removed = 0;
  for (const dir of legacyDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      summary.push(`  Removed: ${dir}`);
      removed++;
    }
  }

  if (removed === 0) {
    summary.push('  No legacy directories to clean up.');
  }
}

// ── Command ─────────────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: 'migrate',
    description: 'Migrate from v0.9.x XDG layout to v0.10.0 ~/.openpalm/ layout',
  },
  args: {
    cleanup: {
      type: 'boolean',
      description: 'Remove old XDG directories after verifying migration',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be done without making changes',
      default: false,
    },
  },
  async run({ args }) {
    const dryRun = args['dry-run'];
    const openpalmHome = resolveOpenPalmHome();

    console.log('OpenPalm Migration (v0.9.x -> v0.10.0)');
    console.log('========================================\n');

    // ── Cleanup mode ────────────────────────────────────────────────
    if (args.cleanup) {
      console.log('Cleanup mode: removing legacy directories.\n');

      if (dryRun) {
        console.log('Dry run — no changes will be made.\n');
      }

      const summary: string[] = [];
      if (!dryRun) {
        cleanupLegacyDirs(summary);
      } else {
        const legacy = detectLegacyLayout();
        if (legacy.detected) {
          if (legacy.configHome) summary.push(`  Would remove: ${legacy.configHome}`);
          if (legacy.dataHome) summary.push(`  Would remove: ${legacy.dataHome}`);
          if (legacy.stateHome) summary.push(`  Would remove: ${legacy.stateHome}`);
        } else {
          summary.push('  No legacy directories found.');
        }
      }

      console.log(summary.join('\n'));
      return;
    }

    // ── Step 1: Check for legacy env vars ────────────────────────────
    const legacyVars = hasLegacyEnvVars();
    if (legacyVars.length > 0) {
      console.log('WARNING: Legacy environment variables detected:');
      for (const v of legacyVars) {
        console.log(`  ${v}=${process.env[v]}`);
      }
      console.log('\nOpenPalm 0.10.0 uses OP_HOME (~/.openpalm by default).');
      console.log('Remove these variables from your shell profile and re-run migration.');
      process.exit(1);
    }

    // ── Step 2: Detect legacy layout ────────────────────────────────
    const legacy = detectLegacyLayout();
    if (!legacy.detected) {
      console.log('No legacy XDG installation detected.');
      console.log(`OpenPalm home: ${openpalmHome}`);

      if (!existsSync(openpalmHome)) {
        console.log('\nCreating fresh directory structure...');
        if (!dryRun) {
          ensureHomeDirs();
        }
        console.log('Done. Run `openpalm install` to set up the stack.');
      }
      return;
    }

    console.log('Legacy XDG installation detected:');
    if (legacy.configHome) console.log(`  Config: ${legacy.configHome}`);
    if (legacy.dataHome) console.log(`  Data:   ${legacy.dataHome}`);
    if (legacy.stateHome) console.log(`  State:  ${legacy.stateHome}`);
    console.log(`\nMigrating to: ${openpalmHome}\n`);

    if (dryRun) {
      console.log('Dry run — no changes will be made.\n');
    }

    const summary: string[] = [];

    // ── Step 3: Create new directory structure ──────────────────────
    console.log('Creating directory structure...');
    if (!dryRun) {
      ensureHomeDirs();
    }
    summary.push('  Created ~/.openpalm/ directory structure');

    // ── Step 4: Move directories ────────────────────────────────────
    console.log('Copying files...');

    if (!dryRun) {
      const configHome = legacy.configHome;
      const dataHome = legacy.dataHome;
      const stateHome = legacy.stateHome;

      // Config files
      if (configHome) {
        // Assistant/opencode config
        await copyDirSafe(
          join(configHome, 'opencode'),
          join(openpalmHome, 'config', 'assistant'),
          summary,
        );
        await copyDirSafe(
          join(configHome, 'assistant'),
          join(openpalmHome, 'config', 'assistant'),
          summary,
        );
        await copyDirSafe(
          join(configHome, 'automations'),
          join(openpalmHome, 'config', 'automations'),
          summary,
        );
        await copyDirSafe(
          join(configHome, 'connections'),
          join(openpalmHome, 'config', 'connections'),
          summary,
        );
        await copyDirSafe(
          join(configHome, 'stash'),
          join(openpalmHome, 'config', 'stash'),
          summary,
        );
      }

      // Data directories
      if (dataHome) {
        await copyDirSafe(join(dataHome, 'admin'), join(openpalmHome, 'data', 'admin'), summary);
        await copyDirSafe(join(dataHome, 'assistant'), join(openpalmHome, 'data', 'assistant'), summary);
        await copyDirSafe(join(dataHome, 'memory'), join(openpalmHome, 'data', 'memory'), summary);
        await copyDirSafe(join(dataHome, 'guardian'), join(openpalmHome, 'data', 'guardian'), summary);
        await copyDirSafe(join(dataHome, 'opencode'), join(openpalmHome, 'data', 'assistant'), summary);
      }

      // State -> logs
      if (stateHome) {
        await copyDirSafe(
          join(stateHome, 'opencode'),
          join(openpalmHome, 'logs', 'opencode'),
          summary,
        );
        await copyDirSafe(
          join(stateHome, 'audit'),
          join(openpalmHome, 'logs', 'audit'),
          summary,
        );
        // STATE_HOME/artifacts is discarded (staging tier eliminated)
        summary.push('  state/artifacts/ (discarded — staging tier eliminated)');
      }

      // Workspace
      const oldWorkDir = join(homedir(), 'openpalm');
      if (existsSync(oldWorkDir)) {
        await copyDirSafe(oldWorkDir, join(openpalmHome, 'data', 'workspace'), summary);
      }
    } else {
      summary.push('  (dry run — no files copied)');
    }

    // ── Step 5: Split env files ─────────────────────────────────────
    console.log('Splitting environment files...');
    if (!dryRun && legacy.configHome) {
      splitEnvFiles(
        legacy.configHome,
        legacy.dataHome ?? '',
        openpalmHome,
        summary,
      );
    } else if (!dryRun) {
      summary.push('  No config home found — skipping env file split.');
    } else {
      summary.push('  (dry run — no env files split)');
    }

    // ── Step 6: Convert channel overlays ────────────────────────────
    console.log('Converting channel overlays to component instances...');
    if (!dryRun && legacy.configHome) {
      convertChannelOverlays(legacy.configHome, openpalmHome, summary);
    } else if (!dryRun) {
      summary.push('  No config home found — skipping channel conversion.');
    } else {
      summary.push('  (dry run — no channels converted)');
    }

    // ── Summary ─────────────────────────────────────────────────────
    console.log('\n========================================');
    console.log('Migration Summary:');
    console.log('========================================\n');
    for (const line of summary) {
      console.log(line);
    }

    console.log('\n========================================');
    if (dryRun) {
      console.log('Dry run complete. Re-run without --dry-run to apply changes.');
    } else {
      console.log('Migration complete. Old directories preserved at:');
      if (legacy.configHome) console.log(`  ${legacy.configHome}`);
      if (legacy.dataHome) console.log(`  ${legacy.dataHome}`);
      if (legacy.stateHome) console.log(`  ${legacy.stateHome}`);
      console.log("\nRun 'openpalm migrate --cleanup' to remove them after verifying.");
      console.log("Run 'openpalm status' to verify the stack is working.");
    }
  },
});
