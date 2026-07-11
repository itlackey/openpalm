/**
 * `openpalm client-serve` — run the @openpalm/client static server in the
 * foreground (P5c, #555). This is the child process the `openpalm` /
 * `openpalm admin` supervisor spawns when the CLI runs as a COMPILED binary
 * (a compiled binary cannot execute a bare .mjs path the way `bun` can, so it
 * re-invokes itself and imports the serve script in-process on the embedded
 * runtime — the same pattern as `openpalm ui` / runUiBuild).
 *
 * The serve script (bin/serve.mjs, zero-dependency) reads PORT / HOST /
 * OP_CLIENT_DIR from the environment; the supervisor pins HOST=127.0.0.1 and
 * OP_CLIENT_DIR to the resolved build before spawning.
 */
import { defineCommand } from 'citty';
import { existsSync as nodeExistsSync } from 'node:fs';
import { resolveClientAppPort, resolveClientBuildDir } from '@openpalm/lib';
import { resolveClientServeScript } from '../lib/client-server.ts';

/** Injectable dependencies for {@link runClientServeCommand} (real fs/import/exit by default). */
export interface RunClientServeDeps {
  existsSync?: (path: string) => boolean;
  resolveBuildDir?: () => string;
  /** Import (and thereby start) the resolved serve script — the listening
   *  socket keeps the process alive. Defaults to a real dynamic import. */
  importServeScript?: (path: string) => Promise<unknown>;
  exit?: (code: number) => void;
  logError?: (...args: unknown[]) => void;
}

/**
 * Run the client static server directly in the foreground. Exported (with
 * injectable deps) so the D4 port-default fix is unit-testable without
 * actually importing/starting serve.mjs.
 *
 * D4: a direct `openpalm client-serve` invocation (no supervisor) left PORT
 * unset, so serve.mjs fell back to ITS OWN default (4180) instead of the
 * platform's stable client port (3890, OP_HOST_CLIENT_PORT) — every OTHER
 * path to the client app (the CLI supervisor, Electron, the docs) agrees on
 * 3890/OP_HOST_CLIENT_PORT; only this direct-invocation path diverged.
 */
export async function runClientServeCommand(deps: RunClientServeDeps = {}): Promise<void> {
  const exists = deps.existsSync ?? nodeExistsSync;
  const resolveBuildDir = deps.resolveBuildDir ?? resolveClientBuildDir;
  const importServeScript = deps.importServeScript ?? ((path: string) => import(path));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const logError = deps.logError ?? console.error;

  // OP_CLIENT_DIR (set by the supervisor) pins the served build; a direct
  // invocation falls back to the shared resolver.
  const buildDir = process.env.OP_CLIENT_DIR ?? resolveBuildDir();
  const serveScript = resolveClientServeScript(buildDir);
  if (!exists(serveScript)) {
    logError(`Client serve script not found at ${serveScript}`);
    logError('Run: bun run client:build');
    exit(1);
    return;
  }
  process.env.OP_CLIENT_DIR ??= buildDir;
  // D4: default PORT to the platform's client port resolution (OP_HOST_CLIENT_PORT
  // / DEFAULT_CLIENT_PORT=3890) BEFORE importing serve.mjs, which only applies
  // its own 4180 fallback when PORT is unset.
  process.env.PORT ??= String(resolveClientAppPort(process.env));
  // Importing the script starts the HTTP server; the listening socket keeps
  // the process alive.
  await importServeScript(serveScript);
}

export default defineCommand({
  meta: {
    name: 'client-serve',
    description:
      'Run the client app static server in the foreground (no supervisor). ' +
      'This is the child process the bare `openpalm` supervisor spawns.',
  },
  async run() {
    await runClientServeCommand();
  },
});
