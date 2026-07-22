import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOpenCodeFixture } from './opencode-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, '../..');
const uiPort = Number(process.env.OP_PWA_UI_PORT ?? 4174);
const fixturePort = Number(process.env.OP_PWA_FIXTURE_PORT ?? 4175);
const hostUiPort = Number(process.env.OP_PWA_HOST_UI_PORT ?? 4176);
const origin = `http://localhost:${uiPort}`;
const hostOrigin = `http://localhost:${hostUiPort}`;
const runtimeRoot = mkdtempSync(join(tmpdir(), 'openpalm-pwa-runtime-'));
const opHome = join(runtimeRoot, 'client-home');
const hostOpHome = join(runtimeRoot, 'host-home');
const uiBuild = join(runtimeRoot, 'build');

mkdirSync(opHome);
mkdirSync(hostOpHome);
cpSync(join(uiRoot, 'build'), uiBuild, { recursive: true });
if (!existsSync(join(uiBuild, '.openpalm-runtime-config-endpoint-v1'))) {
  throw new Error('UI build is missing the process runtime-config capability marker');
}

if (readdirSync(opHome).length !== 0) throw new Error(`Temporary OP_HOME was not empty: ${opHome}`);
if (readdirSync(hostOpHome).length !== 0) {
  throw new Error(`Temporary host OP_HOME was not empty: ${hostOpHome}`);
}

const fixture = await startOpenCodeFixture({
  port: fixturePort,
  allowedOrigins: [origin, hostOrigin],
});
const childEnv = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: String(uiPort),
  ORIGIN: origin,
  OP_HOME: opHome,
  OP_UI_RUNTIME_CONFIG_JSON: '{"connections":[]}',
};
delete childEnv.OP_ENABLE_ADMIN;
delete childEnv.OP_INSIDE_ELECTRON;
delete childEnv.OP_UI_LOGIN_PASSWORD;

const ui = spawn(process.execPath, ['build/index.js'], {
  cwd: runtimeRoot,
  env: childEnv,
  stdio: 'inherit',
});

const hostUi = spawn(process.execPath, ['build/index.js'], {
  cwd: runtimeRoot,
  env: {
    ...childEnv,
    PORT: String(hostUiPort),
    ORIGIN: hostOrigin,
    OP_HOME: hostOpHome,
    OP_ENABLE_ADMIN: '1',
  },
  stdio: 'inherit',
});

console.log(
  `[pwa-e2e] client ${origin}; host-first-run ${hostOrigin}; fixture http://127.0.0.1:${fixturePort}`,
);

let stopping = false;
function running(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function stopChild(child) {
  if (!running(child)) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
  if (running(child)) child.kill('SIGKILL');
  await exited;
}

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  fixture.closeAllConnections();
  await new Promise((resolveClose) => fixture.close(resolveClose));
  await Promise.all([stopChild(ui), stopChild(hostUi)]);
  rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  process.exit(exitCode);
}

process.once('SIGINT', () => void stop(130));
process.once('SIGTERM', () => void stop(143));
ui.once('exit', (code, signal) => {
  if (!stopping) {
    console.error(`[pwa-e2e] adapter-node exited unexpectedly (${signal ?? code ?? 1})`);
    void stop(code ?? 1);
  }
});
hostUi.once('exit', (code, signal) => {
  if (!stopping) {
    console.error(`[pwa-e2e] host adapter-node exited unexpectedly (${signal ?? code ?? 1})`);
    void stop(code ?? 1);
  }
});
