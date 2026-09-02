/**
 * Core runtime asset management for the OpenPalm control plane.
 *
 * Manages source-of-truth files for the ~/.openpalm/ layout:
 *   system/stack/       — system-owned compose files, refreshed every reconcile
 *
 * This module manages runtime-owned core files only.
 * Addon compose bundle generation and registry catalog refresh are handled
 * separately in addons.ts.
 * Env validation has moved to `akm vault` + the in-house redactor — the
 * historical `.env.schema` files (varlock format) were retired in #391.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync
} from 'node:fs';
import { actionableOwnershipError, errMessage } from './errors.js';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, resolveOpenPalmHome, resolveBackupsDir } from './home.js';
import { createLogger } from '../logger.js';
import { sha256 } from './crypto.js';

const logger = createLogger('core-assets');

function bundledAssetPath(relPath: string): string {
	// 1. Explicit skeleton directory (Electron resources or extracted host assets)
	const skeletonDir = process.env.OPENPALM_SKELETON_DIR;
	if (skeletonDir) return join(skeletonDir, relPath);

	// 2. OPENPALM_REPO_ROOT env var (explicit dev override or test preload)
	const repoRoot = process.env.OPENPALM_REPO_ROOT;
	if (repoRoot) return join(repoRoot, 'packages', 'skeleton', relPath);

	// 3. Source-relative fallback — works when running from the repo tree
	//    (bun run, bun test). This file lives at
	//    packages/lib/src/control-plane/core-assets.ts; skeleton is four levels up.
	try {
		const meta = fileURLToPath(import.meta.url);
		const candidate = join(dirname(meta), '..', '..', '..', '..', 'packages', 'skeleton', relPath);
		// Only return this candidate if the skeleton package.json exists (sanity check)
		if (
			existsSync(
				join(dirname(meta), '..', '..', '..', '..', 'packages', 'skeleton', 'package.json')
			)
		) {
			return candidate;
		}
	} catch {
		/* fall through */
	}

	throw new Error(
		'OpenPalm skeleton assets not found. Set OPENPALM_REPO_ROOT or OPENPALM_SKELETON_DIR.'
	);
}

// ── Core Compose (stack/) ─────────────────────────────────────────────

export function readCoreCompose(): string {
	const livePath = `${resolveOpenPalmHome()}/system/stack/core.compose.yml`;
	if (existsSync(livePath)) {
		return readFileSync(livePath, 'utf-8');
	}
	return readFileSync(bundledAssetPath('system/stack/core.compose.yml'), 'utf-8');
}

export function readBundledStackAsset(name: string): string {
	// The bundled `.openpalm` assets are resolved relative to import.meta.url,
	// which does not survive bundling into the UI/Electron build (the path lands
	// outside the packaged app). When OP_HOME is already seeded this fallback is
	// never reached; when it is NOT (e.g. a fresh Electron first-run) the read
	// fails. Degrade gracefully to "" so callers (addon profile/service lookups)
	// return empty rather than throwing a 500 — the live OP_HOME assets are the
	// source of truth once seeded.
	try {
		return readFileSync(bundledAssetPath(`system/stack/${name}`), 'utf-8');
	} catch (err) {
		logger.warn('bundled stack asset unavailable (returning empty)', {
			name,
			error: errMessage(err)
		});
		return '';
	}
}

/**
 * The bundled USER custom.compose.yml default. Unlike the managed trio it ships
 * in the user tree (config/stack/), so it is resolved separately. Used only to
 * seed the file once when absent — never to overwrite an existing user overlay.
 */
export function readBundledCustomCompose(): string {
	try {
		return readFileSync(bundledAssetPath('config/stack/custom.compose.yml'), 'utf-8');
	} catch (err) {
		logger.warn('bundled custom.compose.yml unavailable (returning empty)', {
			error: errMessage(err)
		});
		return '';
	}
}

// ── OpenCode System Config ──────────────────────────────────────────

export function ensureOpenCodeSystemConfig(): void {
	const dir = `${resolveDataDir()}/assistant`;
	mkdirSync(dir, { recursive: true });
}

// ── Managed system/ tree overwrite ───────────────────────────────────

function ensureBackupDir(backupDir: string | null, suffix = ''): string {
	if (backupDir) return backupDir;
	return join(resolveBackupsDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}${suffix}`);
}

/**
 * Overwrite the entire MANAGED `system/` tree from the release skeleton.
 *
 * This is the "overwrite the managed tree" primitive (constitution §1):
 * `system/` IS the skeleton, so every install/update blind-copies the release's
 * `system/` over OP_HOME/system — compose stack AND the system OpenCode config
 * (plugins/permissions/instructions). Unchanged files are skipped; changed ones
 * are backed up first (full recovery). User trees, `data/`, and `state/` are
 * NEVER touched here — that is the caller's seed-if-missing step.
 */
export function overwriteSystemTree(
	sourceRoot: string,
	homeDir = resolveOpenPalmHome()
): {
	backupDir: string | null;
	updated: string[];
} {
	const sysSource = join(sourceRoot, 'system');
	if (!existsSync(sysSource)) return { backupDir: null, updated: [] };

	const targetRoot = join(homeDir, 'system');
	const nonce = `${Date.now()}-${process.pid}`;
	const stageRoot = join(homeDir, `.system-staging-${nonce}`);
	const previousRoot = join(homeDir, `.system-previous-${nonce}`);

	// #641/#642, #653: every copy/rename/rm below can hit a file a PRIOR run
	// left root-owned (or foreign-owned after a host/drive swap) and surface a
	// bare `EACCES: permission denied, rm '…'`/`copyfile '…'` with no next
	// step. Map that one failure class to an actionable message naming the
	// path and the remedy; everything else still throws unchanged.
	try {
		cpSync(sysSource, stageRoot, { recursive: true });

		const sourceFiles = listFiles(stageRoot);
		const currentFiles = existsSync(targetRoot) ? listFiles(targetRoot) : [];
		const sourceSet = new Set(sourceFiles);
		const removedFiles = currentFiles.filter((rel) => !sourceSet.has(rel));
		// Target-only paths are two different things and must be told apart. A file
		// the new release RETIRED has to count as a change, or it survives under
		// OP_HOME/system forever (nothing else prunes the managed tree). A RUNTIME
		// extra must NOT: the assistant's bind-mounted OPENCODE_CONFIG_DIR
		// accumulates plugin dependencies under node_modules/, and counting those
		// would make every launch read 'changed' and re-back-up/rewrite the whole
		// tree — wiping them and growing backups unboundedly.
		const retiredFiles = removedFiles.filter((rel) => !isRuntimeExtra(rel));
		const changed =
			retiredFiles.length > 0 ||
			sourceFiles.some((rel) => {
				const current = join(targetRoot, rel);
				return (
					!existsSync(current) ||
					sha256(readFileSync(current, 'utf8')) !== sha256(readFileSync(join(stageRoot, rel), 'utf8'))
				);
			});
		if (!changed) {
			rmSync(stageRoot, { recursive: true, force: true });
			return { backupDir: null, updated: [] };
		}

		let backupDir: string | null = null;
		if (existsSync(targetRoot)) {
			backupDir = ensureBackupDir(null);
			cpSync(targetRoot, join(backupDir, 'system'), { recursive: true });
			renameSync(targetRoot, previousRoot);
		}

		try {
			renameSync(stageRoot, targetRoot);
		} catch (error) {
			if (existsSync(previousRoot)) renameSync(previousRoot, targetRoot);
			rmSync(stageRoot, { recursive: true, force: true });
			throw error;
		}
		rmSync(previousRoot, { recursive: true, force: true });

		return {
			backupDir,
			updated: [...sourceFiles, ...removedFiles].map((rel) => join('system', rel))
		};
	} catch (err) {
		// targetRoot (the pre-existing system/ tree) is the read side of the
		// backup-copy cpSync below — the one that can hold a file a prior run
		// left foreign-owned. sysSource is release-shipped and never the
		// realistic offender, so it is not worth a second scan.
		throw actionableOwnershipError(err, targetRoot) ?? err;
	}
}

/**
 * A target-only path the release never shipped and that must not be read as a
 * retirement. OP_HOME/system/assistant is bind-mounted as OPENCODE_CONFIG_DIR,
 * so the container writes into it:
 *
 *  - `node_modules/` — OpenCode installs plugin dependencies there.
 *  - `assistant/AGENTS.md` — the entrypoint seeds the image's default there on
 *    every boot, and the skeleton ships no copy. So it read as permanently
 *    "retired": `changed` was true on EVERY run, which made each launch copy
 *    the whole system/ tree into a fresh data/backups/<ts>/ and then replace
 *    the tree — deleting the very node_modules the first entry protects, and
 *    swapping the inode of a directory the running assistant has bind-mounted.
 *    Electron does this per launch and the backup prune only runs on
 *    install/update, so backups accumulated (24 where this was found).
 */
function isRuntimeExtra(rel: string): boolean {
	const segments = rel.split(/[\\/]/);
	if (segments.includes('node_modules')) return true;
	return segments.length === 2 && segments[0] === 'assistant' && segments[1] === 'AGENTS.md';
}

function listFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(root, path));
			else throw new Error(`Invalid managed system asset: ${relative(root, path)}`);
		}
	};
	walk(root);
	return files.sort();
}
