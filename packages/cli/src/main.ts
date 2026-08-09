#!/usr/bin/env bun
import { defineCommand, parseArgs, runCommand, runMain, type ArgsDef } from 'citty';
import cliPkg from '../package.json' with { type: 'json' };
import { classifyLocalInstall, resolveStackDir, resolveOpenPalmHome, resolveEnvPort, readStackEnv } from '@openpalm/lib';
import { DEFAULT_ASSISTANT_PORT, DEFAULT_UI_PORT } from './lib/ports.ts';

// Re-export public API used by tests and external consumers
export { detectHostInfo } from './lib/host-info.ts';
export type { HostInfo } from './lib/host-info.ts';

export interface BareRunOpts {
  port?: number;
  open?: boolean;
}

/**
 * Bare-command flags — the ONE definition both `mainCommand`'s --help text
 * and the actual bare-run parsing below use. Before this they were two
 * independent sources of truth (mainCommand.args existed for --help only; a
 * hand-rolled parseBareArgs did the real parsing) that had already drifted:
 * the hand-rolled parser understood `--no-open` but not `--open=false`, and
 * silently dropped a malformed `--port` instead of erroring.
 */
const bareArgsDef = {
  port: {
    type: 'string',
    description: `UI server port (default: ${DEFAULT_UI_PORT} or OP_HOST_UI_PORT)`,
  },
  open: {
    type: 'boolean',
    description: 'Open browser after start (use --no-open to skip)',
    default: true,
  },
} satisfies ArgsDef;

/**
 * Probe the assistant container's healthcheck to decide whether the stack
 * is already up. We hit the assistant's published host port (default 3810,
 * overridable via OP_ASSISTANT_PORT) rather than introspect Docker so this
 * works without docker socket access and respects whatever overrides are
 * active.
 *
 * The probe sends no Basic auth, so when direct Assistant access enables
 * OpenCode auth (`OPENCODE_AUTH=true`) the Assistant answers
 * `/health` with 401 — which is proof the container is up and listening, not a
 * reason to run `docker compose up -d` and needlessly recreate a healthy stack.
 * Treat a 401/403 (auth-gated but reachable) exactly like a 2xx. Only a thrown
 * connection error (refused/timeout) or a 5xx (the assistant is up but broken —
 * a restart, not a recreate, is the operator's tool) reads as "not up".
 */
export async function isAssistantHealthy(): Promise<boolean> {
  // Read the SAME persisted-over-live merge every other port resolver uses
  // (resolveUiServePort et al) — a file install persists a custom
  // OP_ASSISTANT_PORT to stack.env, and live env alone (the old behavior)
  // never saw it, so this probed the wrong port, read the stack as "down",
  // and force-recreated a perfectly healthy install on a different port.
  const port = resolveEnvPort(
    'OP_ASSISTANT_PORT',
    DEFAULT_ASSISTANT_PORT,
    process.env,
    readStackEnv(resolveOpenPalmHome()),
  );
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

/**
 * Smart default: `openpalm` (no subcommand) detects state and does the
 * right thing automatically.
 *
 *  - Not installed → runs the install flow (seeds OP_HOME, spawns wizard)
 *  - Installed, stack down → starts the stack
 *  - Installed, stack up → starts the UI host server (foreground)
 *
 * The UI server runs in the foreground until SIGINT/SIGTERM. This is
 * the canonical way to "run OpenPalm". `openpalm admin` serves the same
 * UI with the host admin capability enabled (loopback-only).
 */
async function autoRun(opts: BareRunOpts = {}): Promise<void> {
  const isInstalled = classifyLocalInstall(resolveStackDir(), resolveOpenPalmHome()) !== 'not_installed';

  if (!isInstalled) {
    const { bootstrapInstall } = await import('./commands/install.ts');
    // C9: this used to also destructure resolveDefaultInstallRef and await
    // its GitHub `releases/latest` lookup (up to ~10s, worst on an offline
    // machine) purely to compute `version` — but prepareInstallFiles' own
    // `version` parameter is unused (host assets are always this binary's
    // embedded build; see C7), so the result was discarded. A bare
    // `openpalm` on a fresh machine no longer waits on the network for a
    // value nothing reads.
    await bootstrapInstall({
      force: false,
      noStart: false,
      noOpen: opts.open === false,
      assumeYes: false,
    });
    return;
  }

  // Ensure the stack is up. Skip when the assistant is already healthy —
  // calling `docker compose up -d` would otherwise recreate containers
  // (when compose config differs, e.g. dev overlays add port bindings)
  // and tear down test/dev port mappings.
  const stackAlreadyUp = await isAssistantHealthy();
  if (!stackAlreadyUp) {
    const { runStartAction } = await import('./commands/start.ts');
    await runStartAction([]).catch((err) => {
      console.warn(`Warning: failed to ensure stack is running: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Start the UI host server in the foreground (blocks until SIGINT/SIGTERM).
  const { startUIServer } = await import('./lib/ui-server.ts');
  await startUIServer({ port: opts.port, open: opts.open });
}

// Single source of truth for the registered subcommands. SUBCOMMAND_NAMES is
// derived from these keys below so adding a subcommand here can never drift
// out of sync with the bare-command routing table.
const subCommands = {
  admin: () => import('./commands/admin.ts').then((m) => m.default),
  app: () => import('./commands/app.ts').then((m) => m.default),
  install: () => import('./commands/install.ts').then((m) => m.default),
  uninstall: () => import('./commands/uninstall.ts').then((m) => m.default),
  update: () => import('./commands/update.ts').then((m) => m.default),
  'self-update': () => import('./commands/self-update.ts').then((m) => m.default),
  addon: () => import('./commands/addon.ts').then((m) => m.default),
  doctor: () => import('./commands/doctor.ts').then((m) => m.default),
  start: () => import('./commands/start.ts').then((m) => m.default),
  'repair-ownership': () => import('./commands/repair-ownership.ts').then((m) => m.default),
  stop: () => import('./commands/stop.ts').then((m) => m.default),
  restart: () => import('./commands/restart.ts').then((m) => m.default),
  logs: () => import('./commands/logs.ts').then((m) => m.default),
  status: () => import('./commands/status.ts').then((m) => m.default),
  backups: () => import('./commands/backups.ts').then((m) => m.default),
  validate: () => import('./commands/validate.ts').then((m) => m.default),
  scan: () => import('./commands/scan.ts').then((m) => m.default),
  'audit-secrets': () => import('./commands/audit-secrets.ts').then((m) => m.default),
  rollback: () => import('./commands/rollback.ts').then((m) => m.default),
  automations: () => import('./commands/automations.ts').then((m) => m.default),
  unlock: () => import('./commands/unlock.ts').then((m) => m.default),
  'reset-password': () => import('./commands/reset-password.ts').then((m) => m.default),
  ui: () => import('./commands/ui.ts').then((m) => m.default),
};

export const mainCommand = defineCommand({
  meta: {
    name: 'openpalm',
    version: cliPkg.version,
    description: 'OpenPalm CLI — install and manage a self-hosted OpenPalm stack',
  },
  args: bareArgsDef,
  subCommands,
});

// Derived from the command registry (plus citty's built-in help/version
// aliases) so `main()` and the bare-command entrypoint route identically and
// never mis-route a newly added subcommand.
const SUBCOMMAND_NAMES = new Set<string>([
  ...Object.keys(subCommands),
  '--help', '-h', 'help',
]);

/** A lone `--version`/`-v` flag prints the version and does nothing else. */
function isVersionFlag(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v');
}

/** True when the first arg names a registered subcommand (or help alias). */
function hasSubcommand(argv: string[]): boolean {
  const first = argv[0];
  return first !== undefined && SUBCOMMAND_NAMES.has(first);
}

/**
 * True when argv's first token looks like an ATTEMPTED subcommand — a bare,
 * non-flag word — that isn't registered (C8): `openpalm statsu` is almost
 * certainly a typo for `status`, not an instruction to run the bare
 * auto-detect flow, which used to swallow it and start the stack. A leading
 * flag (`--port 1234`) or no token at all (bare `openpalm`) is genuinely "no
 * subcommand" and must keep going to autoRun.
 */
function isUnknownSubcommand(argv: string[]): boolean {
  const first = argv[0];
  if (first === undefined || first.startsWith('-')) return false;
  return !SUBCOMMAND_NAMES.has(first);
}

/** The shared "unknown command" message for both entry points below. */
function unknownCommandMessage(command: string): string {
  return `Unknown command: ${command}. Run \`openpalm --help\` to see available commands.`;
}

/**
 * Parse `--port`/`--open`/`--no-open` from a bare-command argv, via citty's
 * own `parseArgs` against `bareArgsDef` — the SAME definition `mainCommand`
 * uses for --help, instead of a hand-rolled loop that had drifted from it: it
 * understood `--no-open` but not `--open=false`, and silently dropped a
 * malformed `--port` (`Number('banana')` → NaN, which resolveHostUiPort's own
 * `Number.isFinite` guard then discards with no indication anything was
 * wrong, quietly falling back to the persisted/default port instead).
 */
export function parseBareArgs(argv: string[]): BareRunOpts {
  const parsed = parseArgs<typeof bareArgsDef>(argv, bareArgsDef);
  // C8-residual: a positional AFTER a flag slips past isUnknownSubcommand
  // (which only inspects argv[0]), and used to be silently discarded here — so
  // `openpalm --no-open status` (or a typo) started the stack instead of
  // erroring. Same error style as unknownCommandMessage.
  const positionals = (parsed._ ?? []).map(String).filter((token) => token.length > 0);
  if (positionals.length > 0) {
    throw new Error(
      `Unexpected argument: ${positionals[0]}. Flags come after the subcommand — ` +
      'use `openpalm <subcommand> [flags]`. Run `openpalm --help` to see available commands.'
    );
  }
  const opts: BareRunOpts = {};
  // `open` defaults to true (bareArgsDef), so only an explicit --no-open /
  // --open=false needs to be threaded through.
  if (parsed.open === false) opts.open = false;
  if (typeof parsed.port === 'string' && parsed.port.length > 0) {
    const port = Number(parsed.port);
    // Integer + range, matching the check startUIServer applies — a merely
    // finite value (3880.5) passed here and failed later, opaquely.
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `Invalid --port value "${parsed.port}". Expected an integer between 1 and 65535.`
      );
    }
    opts.port = port;
  }
  return opts;
}

/**
 * Programmatic entry point for tests and embedding.
 *
 * No-subcommand behaviour: autoRun() detects state and does the right thing.
 * Subcommand: route through citty.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (isVersionFlag(argv)) {
    console.log(cliPkg.version);
    return;
  }
  if (isUnknownSubcommand(argv)) {
    // Thrown (not process.exit) so tests can drive this programmatically —
    // matches how every other validation failure in main() surfaces.
    throw new Error(unknownCommandMessage(argv[0]));
  }
  if (!hasSubcommand(argv)) {
    await autoRun(parseBareArgs(argv));
    return;
  }
  await runCommand(mainCommand, { rawArgs: argv });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // Same routing decision as main(), but subcommands go through citty's
  // runMain so its error formatting + exit handling surface command failures
  // (main() uses runCommand so tests can drive it programmatically).
  if (isVersionFlag(argv)) {
    console.log(cliPkg.version);
  } else if (isUnknownSubcommand(argv)) {
    console.error(unknownCommandMessage(argv[0]));
    process.exit(1);
  } else if (!hasSubcommand(argv)) {
    // parseBareArgs can now throw (a malformed --port) — previously it never
    // did, so this path had no error boundary of its own. Match the
    // unknown-subcommand branch above: one-line message, exit(1).
    try {
      await autoRun(parseBareArgs(argv));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    await runMain(mainCommand);
  }
}
