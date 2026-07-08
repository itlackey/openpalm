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
import { existsSync } from 'node:fs';
import { resolveClientBuildDir } from '@openpalm/lib';
import { resolveClientServeScript } from '../lib/client-server.ts';

export default defineCommand({
  meta: {
    name: 'client-serve',
    description:
      'Run the client app static server in the foreground (no supervisor). ' +
      'This is the child process the bare `openpalm` supervisor spawns.',
  },
  async run() {
    // OP_CLIENT_DIR (set by the supervisor) pins the served build; a direct
    // invocation falls back to the shared resolver.
    const buildDir = process.env.OP_CLIENT_DIR ?? resolveClientBuildDir();
    const serveScript = resolveClientServeScript(buildDir);
    if (!existsSync(serveScript)) {
      console.error(`Client serve script not found at ${serveScript}`);
      console.error('Run: bun run client:build');
      process.exit(1);
    }
    process.env.OP_CLIENT_DIR ??= buildDir;
    // Importing the script starts the HTTP server; the listening socket keeps
    // the process alive.
    await import(serveScript);
  },
});
