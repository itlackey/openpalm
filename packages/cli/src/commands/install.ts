import { defineCommand } from 'citty';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultWorkDir } from '../lib/paths.ts';
import { defineAction } from '../lib/action.ts';
import { promptYesNo } from '../lib/prompt.ts';
import type { UIServerOptions } from '../lib/ui-server.ts';
import {
	resolveOpenPalmHome,
	ensureHomeDirs,
	readStackEnv,
	resolveHostUiPort,
	runHomeMigrations,
	UI_LOOPBACK_HOST,
	hasMaterializedLocalInstall,
	hasAnyStackEnvFile,
	resolveBackupsDirFor,
	resolveRuntimeFiles,
	ensureDockerReady,
	acquireInstallLock,
	releaseInstallLock
} from '@openpalm/lib';
import { applyHomeSeed } from '@openpalm/lib';
import { materializeEmbeddedUi, seedSkeletonFromEmbedded } from '../lib/embedded-assets.ts';
import {
	backupOpenPalmHome,
	pruneBackupDirs,
	ensureOpenCodeConfig,
	ensureOpenCodeSystemConfig,
	performSetup,
	createState,
	createLogger,
	resolveRequestedImageTag,
	ensureAkmUserEnv,
	runDeploy,
	markSetupComplete,
	recordHostEnabled,
	writeSystemEnv,
	patchSecretsEnvFile,
	describeAccessExposure,
	describeSelectedRemoteExposure,
	readAccessToggles,
	resolveDeployJournalPath,
	type DeployPhase,
	type DeployProgress,
	type SetupSpec
} from '@openpalm/lib';
import { detectHostInfo } from '../lib/host-info.ts';
import { ensureValidState } from '../lib/cli-state.ts';
import { runComposeWithPreflight } from '../lib/cli-compose.ts';

const logger = createLogger('cli:install');

export default defineCommand({
	meta: {
		name: 'install',
		description: 'Bootstrap home dirs, download assets, run setup wizard, start core services'
	},
	args: {
		force: {
			type: 'boolean',
			description:
				'Skip "already installed" check. Backs up the existing OP_HOME to ' +
				'data/backups/<timestamp> first, then prunes old backups down to the 3 ' +
				'most recent (pre-rollback/pre-update safety snapshots are never pruned).',
			default: false
		},
		version: {
			type: 'string',
			description:
				"Pin container image tags to a specific release (default: this binary's own " +
				"version). Host assets (UI, skeleton) are always the binary's embedded build " +
				'and are never changed by this flag. Pass "main" for no pin.'
		},
		start: {
			type: 'boolean',
			description:
				'Start services after install (use --no-start to skip). Applies to --file installs ' +
				'only — the setup wizard always configures and starts the stack in one step.',
			default: true
		},
		open: {
			type: 'boolean',
			description: 'Open browser after install (use --no-open to skip)',
			default: true
		},
		file: {
			type: 'string',
			alias: 'f',
			description: 'Path to setup config file (JSON or YAML) — skips wizard'
		},
		yes: {
			type: 'boolean',
			alias: 'y',
			description: 'Auto-confirm destructive prompts (e.g. --force backup of existing OP_HOME)',
			default: false
		}
	},
	run: defineAction(
		async ({ args }) => {
			const requestedVersion = args.version ? String(args.version).trim() : undefined;
			// A user-supplied --version pins the CONTAINER IMAGE tag only — host
			// assets (UI, skeleton) are always this binary's own embedded build,
			// never a downloaded ref (see prepareInstallFiles). "main" is the
			// explicit "no pin" spelling; anything else must be a real release tag,
			// or this is a typo that used to silently fall back to the default pin
			// with no warning at all.
			let explicitImageTag: string | undefined;
			if (requestedVersion && requestedVersion !== 'main') {
				explicitImageTag = resolveRequestedImageTag(requestedVersion) ?? undefined;
				if (!explicitImageTag) {
					throw new Error(
						`Invalid --version value "${requestedVersion}". Expected a release tag like ` +
							'1.2.3 or v1.2.3 (optionally with a pre-release suffix), or "main" for no pin.'
					);
				}
				if (explicitImageTag.replace(/^v/, '') !== cliPkg.version) {
					console.warn(
						`Warning: --version ${requestedVersion} pins container image tags only. This ` +
							`binary's own host assets (UI, skeleton) stay at ${cliPkg.version} regardless ` +
							'of --version — a mismatched pin can run images against compose contracts this ' +
							'host does not ship.'
					);
				}
			}
			// No network lookup here (mirrors C9 in main.ts): host assets are
			// always this binary's embedded build, so a `releases/latest`
			// round-trip would inform nothing and make offline installs block on
			// its timeout. --version affects only the image pin (explicitImageTag).
			await bootstrapInstall({
				force: !!args.force,
				explicitImageTag,
				noStart: !args.start,
				noOpen: !args.open,
				file: args.file ? String(args.file) : undefined,
				assumeYes: !!args.yes
			});
		}
	)
});

type InstallOptions = {
	force: boolean;
	/** Optional image tag pin from an explicit --version. */
	explicitImageTag?: string;
	noStart: boolean;
	noOpen: boolean;
	file?: string;
	assumeYes: boolean;
};

/**
 * Docker/Compose preflight for install — delegates entirely to the lib's own
 * probes rather than a bespoke `docker info`/`docker compose version` check.
 * `ensureDockerReady` distinguishes "daemon stopped" from "socket permission
 * denied" (mapDockerError), tolerates a warning-only `docker info` exit
 * (checkDocker), and its Compose check enforces the `--wait` version floor
 * (checkDockerCompose / meetsComposeWaitFloor) that the final deploy's
 * `--wait` flag needs — a bare version-exists check would pass a too-old
 * Compose that then fails at the very end of the wizard.
 */
async function ensureDockerAndComposeReady(): Promise<void> {
	const result = await ensureDockerReady();
	if (!result.ok) throw new Error(result.message);
}

function describeDeployPhase(phase: DeployPhase): string {
	switch (phase) {
		case 'writing-config':
			return 'Writing configuration...';
		case 'pulling-images':
			return 'Downloading images...';
		case 'starting':
			return 'Starting services...';
		case 'ready':
			return 'Ready.';
		default:
			return phase;
	}
}

/**
 * Print human-readable deploy progress to the terminal for a `--file` install
 * — without this, a headless install prints nothing between "Setup
 * complete." and the final JSON, through a pull budget of 60 minutes plus an
 * up budget of 30 minutes (C6). Diffs against the last-seen phase/labels so
 * each line prints once, when it actually changes.
 */
function reportDeployProgress(
	progress: DeployProgress,
	seen: { phase: DeployPhase | null; labels: Map<string, string> }
): void {
	if (progress.phase !== seen.phase) {
		seen.phase = progress.phase;
		console.log(`[deploy] ${describeDeployPhase(progress.phase)}`);
	}
	for (const entry of progress.deployStatus) {
		if (seen.labels.get(entry.service) !== entry.label) {
			seen.labels.set(entry.service, entry.label);
			console.log(`[deploy]   ${entry.service}: ${entry.label}`);
		}
	}
}

async function deployServices(mode: string): Promise<string[]> {
	const state = ensureValidState();
	const seen: { phase: DeployPhase | null; labels: Map<string, string> } = {
		phase: null,
		labels: new Map()
	};
	// PR #564 second retest R9: pass the setup-completion callback so a healthy
	// non-interactive (file) install records OP_SETUP_COMPLETE=true. Without it,
	// runDeploy brought the stack up healthy but never stamped completion, so the
	// UI later bounced the operator back to the setup wizard. runDeploy only fires
	// this once CORE services are healthy, so it stays correct for every mode.
	const result = await runDeploy(state, {
		markSetupComplete: () => markSetupComplete(state),
		journalPath: resolveDeployJournalPath(state),
		onUpdate: (progress) => reportDeployProgress(progress, seen)
	});
	if (result.deployError) throw new Error(result.deployError);
	console.log(
		JSON.stringify(
			{ ok: true, mode, services: result.deployStatus.map((entry) => entry.service) },
			null,
			2
		)
	);
	return result.deployStatus.map((entry) => entry.service);
}

async function parseConfigFile(filePath: string, raw: string): Promise<Record<string, unknown>> {
	const ext = filePath.toLowerCase();
	const isYaml = ext.endsWith('.yaml') || ext.endsWith('.yml');
	if (!isYaml && !ext.endsWith('.json'))
		throw new Error(`Unsupported config file format: ${filePath}. Use .json or .yaml.`);
	try {
		return isYaml ? (await import('yaml')).parse(raw) : JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`Failed to parse setup config '${filePath}': ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

export async function bootstrapInstall(options: InstallOptions): Promise<void> {
	// #632: --no-start only has meaning on the --file path. prepareInstallFiles
	// deliberately never mints secrets (C1 below) — performSetup is the sole
	// minter, whether reached via runFileInstall or via the wizard the operator
	// drives through the UI. On the wizard path there is nothing for --no-start
	// to skip: the wizard both configures AND deploys in one step, so silently
	// honoring the flag there used to leave a compose-looking home with no
	// secrets and no explanation — Docker's own error only surfaces much later,
	// at the first `docker compose up`. Fail loudly here instead, before
	// anything touches disk.
	if (options.noStart && !options.file) {
		throw new Error(
			'--no-start requires --file: the setup wizard configures and starts the stack in one ' +
				'step. For a non-interactive install that must not start containers, write a setup ' +
				'config and pass --file <path> --no-start (see docs/operations/manual-headless-install.md).'
		);
	}

	// Warn early if any bind address is non-loopback so the operator sees it
	// before services start. #563 — preset-aware: a matched network access
	// preset collapses to one informational line; unexplained exposure stays
	// loud (D9).
	for (const line of describeAccessExposure(
		readAccessToggles(process.env as Record<string, string>)
	)) {
		logger.warn(line);
	}
	// Remote (tunnel) exposure joins the same warn-early report through the
	// provider registry — empty when the addon is off or the keys are absent
	// from this process's env.
	for (const line of describeSelectedRemoteExposure(process.env as Record<string, string>)) {
		logger.warn(line);
	}

	const homeDir = resolveOpenPalmHome();
	const dataDir = `${homeDir}/data`;
	const workDir = defaultWorkDir();

	// Ask the authoritative predicate rather than probing one file. A home still
	// on the pre-consolidation layout has no state/stack.env yet, so a bare
	// existence check on the new path would call a live install "fresh" — running
	// install without --force and skipping the backup confirmation before managed
	// files are refreshed. hasMaterializedLocalInstall also recognizes a
	// materialized stack (compose + guardian tokens), so it is right before OR
	// after migration.
	const alreadyInstalled = hasAnyStackEnvFile(homeDir) || hasMaterializedLocalInstall(homeDir);
	if (alreadyInstalled && !options.force) {
		throw new Error(
			'OpenPalm appears to already be installed. Run `openpalm update` to upgrade it in ' +
				'place, `openpalm uninstall` to remove it, or re-run install with --force to back ' +
				'up the existing home and reinstall.'
		);
	}

	// Docker preflight BEFORE any disk mutation — including the --force backup
	// below. A missing/stopped Docker is the single most likely first-run
	// failure, and prepareInstallFiles seeds a compose file + stack.env that
	// makes THIS SAME home look "already installed" on the very next run (the
	// check above), turning "go install Docker and retry" into a false, scary
	// dead end. Skipped only for the one path that genuinely never touches
	// Docker: a `--file` install with `--no-start` (writes config, never
	// deploys — see runFileInstall).
	const needsDocker = options.file ? !options.noStart : true;
	if (needsDocker) await ensureDockerAndComposeReady();

	if (alreadyInstalled && options.force) {
		// Match backupOpenPalmHome()'s convention so the prompt is honest.
		const plannedBackup = `${resolveBackupsDirFor(homeDir)}/<timestamp>`;

		// Skip the prompt when --yes was passed OR when there's no TTY (CI/scripts).
		// Without the TTY exemption we would silently hang a non-interactive
		// pipeline waiting for stdin, which is worse than auto-confirming.
		const interactive = process.stdin.isTTY && process.stdout.isTTY;
		if (!options.assumeYes && interactive) {
			const proceed = await promptYesNo(
				`--force will back up (copy) the existing OpenPalm install at ${homeDir} to ${plannedBackup} ` +
					'— everything except data/ and cache/ (chat history and other regenerable runtime ' +
					'state are NOT included), and addon credentials leave with their service data/ tree so ' +
					'the two restore together — then prune old backups down to the 3 most recent. Continue? [y/N]'
			);
			if (!proceed) {
				// A declined confirmation is a no-op, not a success: exit non-zero so
				// scripts can tell "the user said no" apart from "the install ran"
				// (this used to `return` here, exiting 0 either way).
				throw new Error(
					'Install aborted. Re-run with --yes (or -y) to skip this confirmation in non-interactive use.'
				);
			}
		}
	}

	// Acquire the install lock across compose-down + backup + prune + the home
	// seed (C10/B10): none of that previously ran under any lock, so two
	// concurrent `--force -y` runs could interleave a backup with a fresh seed.
	// Released BEFORE runFileInstall/runWizardInstall — both reach this SAME
	// lock themselves (performSetup / runDeploy), and the wizard path in
	// particular spawns a long-lived child while THIS process blocks in its own
	// supervisor loop, so holding the lock past this point would make that
	// child's later deploy see it (still) held by a live PID forever.
	const seedLock = acquireInstallLock(dataDir);
	if (!seedLock) {
		throw new Error(
			"install_in_progress: Another install or update is already running. Wait for it to finish, or run 'openpalm unlock' to clear a stale lock."
		);
	}
	try {
		if (alreadyInstalled && options.force) {
			// #461: stop the currently-running stack BEFORE backing up OP_HOME.
			// Backing up the home dir while the old stack is up leaves orphaned containers
			// holding the project name + host ports, so the fresh install collides on
			// `compose up`. Volumes are preserved (no -v). Best-effort: a Docker-down
			// host or a never-started install simply has nothing to bring down.
			try {
				const existingState = createState();
				existingState.artifacts = resolveRuntimeFiles();
				if (existingState.artifacts.compose) {
					console.log('Stopping existing stack before backup...');
					await runComposeWithPreflight(existingState, ['down']);
				}
			} catch (err) {
				if (err instanceof Error && err.message.startsWith('Refusing Compose')) throw err;
				logger.debug('pre-force compose down threw — continuing', { error: String(err) });
			}

			const backupDir = backupOpenPalmHome(homeDir);
			if (backupDir) {
				console.log(`Backed up existing OP_HOME to ${backupDir}`);
				// Bounded retention: keep the most recent few snapshots so repeated
				// --force runs can't accumulate unbounded and fill the disk.
				pruneBackupDirs(homeDir, 3);
			}
		}

		// ── Bootstrap files ────────────────────────────────────────────────────
		await prepareInstallFiles(homeDir, dataDir, workDir);
	} finally {
		releaseInstallLock(seedLock);
	}

	// ── Configure ──────────────────────────────────────────────────────────
	// File-based install: read config, run performSetup, optionally deploy
	if (options.file) {
		await runFileInstall(options.file, options.noStart, options.explicitImageTag);
		return;
	}

	// Interactive wizard: start the admin UI which serves the setup wizard.
	// Reachable unconditionally — the guard above already returned/threw for
	// every `alreadyInstalled && !options.force` case, so getting this far
	// means either the home was fresh or the caller explicitly passed
	// --force; both want the wizard.
	await runWizardInstall(options.noOpen);
}

async function prepareInstallFiles(
	homeDir: string,
	dataDir: string,
	workDir: string
): Promise<void> {
	console.log('Preparing directories...');
	// The tree itself is owned by @openpalm/lib (single definition). workDir is
	// separate because OP_WORK_DIR can point it outside OP_HOME.
	ensureHomeDirs(homeDir);
	await mkdir(workDir, { recursive: true });

	try {
		await Bun.write(
			join(dataDir, 'host.json'),
			`${JSON.stringify(await detectHostInfo(), null, 2)}\n`
		);
	} catch (err) {
		logger.debug('failed to write host.json', { error: String(err) });
	}

	// Seed OP_HOME from the embedded skeleton (falling back to a local repo
	// checkout / OPENPALM_SKELETON_DIR / OPENPALM_REPO_ROOT — see
	// embedded-assets.ts). This is the PRE-WIZARD seed and is load-bearing: the
	// wizard's UI child reads seeded system/stack assets at boot
	// (runStartupApply -> resolveRuntimeFiles), and the bundled-asset fallback
	// does not survive into the packaged UI build, so the live seeded copy must
	// exist before /setup is served.
	//
	// NOT redundant with applyInstall's applyHome: runFileInstall's deploy
	// reaches applyHome via runDeploy -> applyInstall, which re-seeds
	// idempotently; but the interactive wizard serves BEFORE any applyInstall
	// runs (deploy happens later from inside the UI), so this explicit seed is
	// the only one that runs before the wizard comes up.
	await seedSkeletonFromEmbedded(applyHomeSeed, homeDir, dataDir);
	runHomeMigrations(homeDir);
	// Materialize the embedded UI build into data/ui — no network, no backup:
	// this binary's build wins unconditionally once its stamp differs from
	// what's already there (a no-op on a repeat install at the same version).
	try {
		await materializeEmbeddedUi(dataDir);
	} catch (err) {
		logger.warn('UI build not materialized; it will be installed on first UI launch', {
			error: String(err)
		});
	}
	console.log('Configuring secrets...');
	const bootstrapState = createState();
	// Deliberately NOT initializeStateSecrets() here (C1): that mints the
	// guardian tokens performSetup/applyHome are documented as the sole
	// source of (classifyLocalInstall's "installed" fallback treats
	// core.compose.yml + both guardian tokens as strong evidence a real setup
	// ran). Minting them this early — before the wizard has asked a single
	// question — let a Ctrl-C'd wizard read back as a completed install.
	// performSetup (file installs) and applyHome (every deploy, wizard
	// included) both mint the same secrets once setup actually runs, so
	// nothing downstream is left unconfigured by deferring this.
	writeSystemEnv(bootstrapState);
	// Typing `openpalm install` IS the answer to "does this machine host a
	// stack", so record it on the same line as the artifacts that make the home
	// look mid-install. Recording it here rather than after a successful deploy
	// means a Ctrl-C'd install still explains why those artifacts exist.
	recordHostEnabled(bootstrapState.homeDir);
	// Ensure the akm env/user file exists (empty 0600) so the assistant can
	// source it. Owned and edited directly by OpenPalm — see akm-user-env.ts.
	ensureAkmUserEnv(bootstrapState);

	try {
		ensureOpenCodeConfig();
		ensureOpenCodeSystemConfig();
	} catch (err) {
		logger.debug('failed to ensure OpenCode config', { error: String(err) });
	}
}

/**
 * The UI-server options the first-run setup wizard must be served with.
 *
 * `adminHostUi: true` is REQUIRED, not incidental: the wizard writes secrets
 * and deploys the stack, so `/setup` and `/api/setup/*` are gated on the
 * `host:setup` capability (packages/ui features.ts), which only an
 * admin-capable process advertises. Without it `prepareInstallFiles` has
 * already made the home 'setup_incomplete', so the UI redirects every
 * navigation TO /setup while /setup itself 403s — a dead loop at the
 * product's front door. Admin mode also pins the bind to loopback, which is
 * exactly right for a first-run wizard that has not yet set a password.
 *
 * Exported as a pure function so the contract is pinned by a unit test. The
 * composed alternative — driving the whole `install` command — has to mutate
 * the process-global OP_HOME, which races other files in the aggregate suite,
 * and `defineAction` turns any resulting error into `process.exit(1)`.
 */
export function wizardUiServerOptions(
	noOpen: boolean,
	env: NodeJS.ProcessEnv = process.env,
	persistedEnv: Record<string, string | undefined> = {}
): UIServerOptions {
	return {
		open: !noOpen,
		// The shared resolver, not an inline `?? 3880` — that is the exact pattern
		// network-contract.ts was written to retire, and here it did real damage:
		// an explicit `port` short-circuits resolveUiServePort, so a port a
		// headless install had persisted was read back by every serve entry EXCEPT
		// a wizard re-run, which quietly served somewhere else. Callers pass the
		// home's stack.env; a first install has none, and `{}` resolves the same
		// way process.env alone used to.
		port: resolveHostUiPort(undefined, env, persistedEnv),
		adminHostUi: true,
	};
}

/**
 * Launch the UI host server to handle first-time setup.
 *
 * The SvelteKit UI detects that setup is not complete (via hooks.server.ts)
 * and redirects to /setup where the wizard runs. Deploy is triggered from
 * within the UI process after the user completes the wizard.
 *
 * Pre-flight: the Docker/Compose check now runs in `bootstrapInstall`, BEFORE
 * any disk mutation (C1) — so users hit our friendly Docker error before
 * `prepareInstallFiles` has seeded anything, and before the browser opens to
 * a wizard that would otherwise fail at the end of a 10-step flow.
 */
async function runWizardInstall(noOpen: boolean): Promise<void> {
	const options = wizardUiServerOptions(noOpen, process.env, readStackEnv(resolveOpenPalmHome()));
	// Same loopback spelling the server binds, the browser is opened to, and
	// ORIGIN is pinned to (UI_LOOPBACK_HOST). A wizard session established on
	// `localhost` is a different cookie jar from the one `openpalm admin` later
	// serves on `127.0.0.1`, which is how finishing setup used to hand the
	// operator a login prompt on their very next command.
	const wizardUrl = `http://${UI_LOOPBACK_HOST}:${options.port}/setup`;
	console.log(`Setup wizard: ${wizardUrl}`);
	// C5: the wizard is loopback-only by design (SEC-4, admin mode always
	// pins the bind) — on a remote/SSH host that URL is otherwise unreachable
	// and nothing pointed the operator at the one thing that works: tunneling
	// the port over the SSH connection they're already using.
	console.log(
		`On a remote host, tunnel it first: ssh -L ${options.port}:127.0.0.1:${options.port} <user>@<host>`
	);
	const { startUIServer } = await import('../lib/ui-server.ts');
	await startUIServer(options);
}

async function runFileInstall(
	filePath: string,
	noStart: boolean,
	explicitImageTag?: string
): Promise<void> {
	console.log(`Reading setup config from ${filePath}...`);
	if (!(await Bun.file(filePath).exists())) {
		throw new Error(
			`Setup config file not found: ${filePath}. Check the --file path and try again.`
		);
	}
	const config = await parseConfigFile(filePath, await Bun.file(filePath).text());

	if (config.version !== 2)
		throw new Error(
			'Setup config must be version 2. See docs/operations/manual-headless-install.md for the format.'
		);
	if ('spec' in config || 'capabilities' in config) {
		throw new Error(
			'Setup config must use the modern flat shape (`llm`, `embedding`, `security`, `connections`) — legacy `spec`/`capabilities` forms are no longer supported.'
		);
	}

	// A deliberate --version pins the image tag; thread it into the spec so
	// performSetup writes it. With no --version (and no spec imageTag),
	// performSetup defaults platform images to the exact host version.
	if (explicitImageTag && !(config as { imageTag?: string }).imageTag) {
		(config as { imageTag?: string }).imageTag = explicitImageTag;
	}

	// Resolve security.uiLoginPassword from environment when not in spec.
	// Phase 4 (auth/proxy refactor) renamed the env var to OP_UI_LOGIN_PASSWORD
	// and the spec field to security.uiLoginPassword.
	const security = (config.security ?? {}) as Record<string, unknown>;
	if (!security.uiLoginPassword && process.env.OP_UI_LOGIN_PASSWORD) {
		security.uiLoginPassword = process.env.OP_UI_LOGIN_PASSWORD;
		config.security = security;
	}

	const result = await performSetup(config as unknown as SetupSpec);
	if (!result.ok) throw new Error(`Setup failed: ${result.error}`);

	// Persist intentional non-secret runtime overrides from the install shell so
	// a later `openpalm start` reuses the same isolated project/port shape instead
	// of falling back to the live-stack defaults.
	const runtimeOverrides = Object.fromEntries(
		['OP_PROJECT_NAME', 'OP_ASSISTANT_PORT', 'OP_UI_PORT', 'OP_HOST_UI_PORT', 'OP_WORKSPACE_PORT'].flatMap((key) => {
			const value = process.env[key]?.trim();
			return value ? [[key, value]] : [];
		})
	);
	patchSecretsEnvFile(resolveOpenPalmHome(), runtimeOverrides);

	console.log('Setup complete.');
	if (noStart) {
		console.log('Config written. Run `openpalm start` to start services.');
		return;
	}
	// Docker/Compose readiness was already confirmed in bootstrapInstall,
	// before prepareInstallFiles touched disk (C1) — no second check here.
	await deployServices('install');
}
