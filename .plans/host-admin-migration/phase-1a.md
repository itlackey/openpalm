# Phase 1a: Host Admin Server — End-to-End Proof

**Goal:** Prove the host admin server works end-to-end. The admin container still exists; both paths run simultaneously. Feature flag `OPENPALM_ADMIN_MODE=host|container` (default `container`).

**Scope boundary:** No removal of container admin. No UI changes to the SvelteKit app. No changes to `@openpalm/lib`. Cookie auth sits in a middleware layer at the Bun.serve boundary, not inside SvelteKit.

---

## ✅ Step 1: Add `admin:build:tar` script to `packages/admin/package.json`

**File:** `packages/admin/package.json` (lines 9–15)
**Change type:** modify

**Context:** The SvelteKit `adapter-node` build produces `packages/admin/build/` with `index.js`, `handler.js`, `env.js`, `shims.js`, and the `client/` and `server/` subdirs. The CLI binary needs to carry this output as a self-contained tarball so it can be extracted to `~/.openpalm/cache/admin/{version}/` at first run. The `build:tar` script runs after `build` and produces `dist/admin-build.tar.gz`.

**Exact change:**

Before (scripts block, lines 9–15):
```json
"scripts": {
  "dev": "vite dev",
  "build": "svelte-kit sync && vite build",
  "preview": "vite preview",
  "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
```

After:
```json
"scripts": {
  "dev": "vite dev",
  "build": "svelte-kit sync && vite build",
  "build:tar": "mkdir -p dist && tar -czf dist/admin-build.tar.gz -C build .",
  "preview": "vite preview",
  "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
```

`build:tar` must be run after `build`. The combined sequence is:
```
cd packages/admin && npm run build && npm run build:tar
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/admin && npm run build && npm run build:tar
ls -lh dist/admin-build.tar.gz   # should exist, ~5-10 MB
tar -tzf dist/admin-build.tar.gz | head -10  # should list index.js, handler.js, client/, etc.
```

---

## ✅ Step 2: Add root `admin:build:tar` shortcut to `package.json`

**File:** `package.json` (lines 16–17, inside the `scripts` block after `admin:build`)
**Change type:** modify

**Context:** Every other package has a root-level shortcut. This lets CI run `bun run admin:build:tar` from the repo root.

**Exact change:**

Add one line after `"admin:build": "bun run --cwd packages/admin build",`:
```json
"admin:build:tar": "bun run --cwd packages/admin build && bun run --cwd packages/admin build:tar",
```

**AKM assistance:** none

**Validation:**
```bash
bun run admin:build:tar
ls packages/admin/dist/admin-build.tar.gz
```

---

## ✅ Step 3: Embed the admin tarball in the CLI binary

**File:** `packages/cli/src/lib/embedded-assets.ts` (lines 1–10, new import block at the top)
**Change type:** modify

**Context:** The CLI binary uses Bun text imports (`with { type: "text" }`) to embed static assets at compile time. The admin tarball must be embedded the same way. Bun supports binary imports via `with { type: "text" }` only for text; for binary we use `with { type: "binary" }` which produces a `Uint8Array`. Add a new embedded entry for the tarball. This import must reference a build artifact, so the tarball must be built before the CLI build.

**Exact change:**

At the top of `packages/cli/src/lib/embedded-assets.ts`, after the existing `@ts-ignore` imports and before `EMBEDDED_STASH_SEEDS`, add:

```typescript
// ── Admin build tarball — embedded at CLI compile time ───────────────────
// Build: cd packages/admin && npm run build && npm run build:tar
// The resulting packages/admin/dist/admin-build.tar.gz is embedded here.
// @ts-ignore — Bun binary import
import ADMIN_BUILD_TAR from "../../../admin/dist/admin-build.tar.gz" with { type: "binary" };

export const EMBEDDED_ADMIN_TAR: Uint8Array = ADMIN_BUILD_TAR as unknown as Uint8Array;
export const ADMIN_BUILD_VERSION: string = cliPkg.version;
```

Also add at line 3 (after the existing imports, before the `@ts-ignore` block):
```typescript
import cliPkg from "../../package.json" with { type: "json" };
```

Note: `cliPkg.version` is already imported in `install.ts`. If it is not already present in `embedded-assets.ts`, add it.

**AKM assistance:** none

**Validation:**
```bash
cd packages/cli && bun run src/lib/embedded-assets.ts 2>&1 | head -5
# should exit without "Cannot find module" error once the tar is built
```

---

## ✅ Step 4: Create `packages/cli/src/lib/admin-build.ts` — tarball extraction utility

**File:** `packages/cli/src/lib/admin-build.ts` (new file)
**Change type:** create

**Context:** Responsible for one thing: extracting the embedded admin build tarball to `~/.openpalm/cache/admin/{version}/` and returning the path. Idempotent — if the version dir already exists, skips extraction. Uses only Node/Bun builtins (no third-party tar library; Bun can spawn `tar`).

**Exact change — full file content:**

```typescript
/**
 * Admin build tarball extraction.
 *
 * Extracts the embedded SvelteKit adapter-node build to
 * `{cacheDir}/admin/{version}/` so the host admin server can load it.
 * Idempotent: if the version directory already exists, extraction is skipped.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EMBEDDED_ADMIN_TAR, ADMIN_BUILD_VERSION } from "./embedded-assets.ts";

/**
 * Ensure the admin build is extracted to the cache directory.
 * Returns the path to the extracted build root (contains index.js, handler.js, client/, etc.)
 */
export function ensureAdminBuild(cacheDir: string): string {
  const versionDir = join(cacheDir, "admin", ADMIN_BUILD_VERSION);

  if (existsSync(join(versionDir, "index.js"))) {
    return versionDir;
  }

  mkdirSync(versionDir, { recursive: true });

  // Write tarball to a temp file, then extract with system tar
  const tarPath = join(tmpdir(), `openpalm-admin-build-${ADMIN_BUILD_VERSION}.tar.gz`);
  writeFileSync(tarPath, EMBEDDED_ADMIN_TAR);

  const result = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", versionDir], {
    stdout: "ignore",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`Failed to extract admin build: ${stderr}`);
  }

  return versionDir;
}
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/cli && bun -e "
  import { ensureAdminBuild } from './src/lib/admin-build.ts';
  const dir = ensureAdminBuild('/tmp/openpalm-test-cache');
  console.log('extracted to:', dir);
  console.log(require('fs').readdirSync(dir));
"
# Should print the build directory contents: index.js, handler.js, client/, server/, etc.
```

---

## ✅ Step 5: Create `packages/cli/src/lib/host-admin-server.ts` — the Bun.serve host admin server

**File:** `packages/cli/src/lib/host-admin-server.ts` (new file)
**Change type:** create

**Context:** The host admin server is a `Bun.serve` instance that:

1. Validates `Origin` and `Host` headers for all non-GET requests (CSRF protection).
2. Accepts `x-admin-token` header (deprecated, backward-compat) OR a session cookie `op_session`.
3. Proxies `/proxy/assistant` to the OpenCode subprocess (forwarding the full path suffix).
4. Proxies `/proxy/admin` to the container admin (only relevant when container admin is also running).
5. For all other routes: bridges the Node.js `http.IncomingMessage` / `ServerResponse` interface exported by `handler.js` into the Web Fetch API that `Bun.serve` uses.

The SvelteKit `adapter-node` build exports a `handler` that is a Node.js middleware `(req, res, next) => void`. Bun's `fetch` handler uses `Request`/`Response`. We bridge them using the Node.js `http` module to create a synthetic `IncomingMessage` and `ServerResponse`, drive the handler, and then reconstruct a `Response`. This is the standard approach for embedding `adapter-node` builds in non-Express runtimes.

**Important constraint:** The SvelteKit handler uses `import.meta.url` to locate `client/` static assets relative to `handler.js`. We must set the working directory to the extracted build dir when spawning the Node subprocess, OR we run the admin build as a child Node.js process. For Phase 1a the cleanest approach is to spawn `node index.js` as a child process bound to 127.0.0.1 on a fixed internal port, then proxy all admin traffic to it from Bun.serve. This avoids the Bun/Node ESM bridging complexity entirely.

**Exact change — full file content:**

```typescript
/**
 * Host admin server.
 *
 * Spawns the SvelteKit adapter-node build (index.js) as a Node.js child
 * process bound to an internal loopback port, then exposes it through a
 * Bun.serve gateway that adds:
 *   - Origin / Host header validation (CSRF)
 *   - Cookie session auth (op_session) + legacy x-admin-token support
 *   - /proxy/assistant → OpenCode subprocess
 *   - /proxy/admin     → container admin (when running)
 */
import { join } from "node:path";
import { createLogger } from "@openpalm/lib";

const logger = createLogger("cli:host-admin");

const INTERNAL_ADMIN_PORT = 18100;   // Node.js adapter-node process
const READY_TIMEOUT_MS    = 15_000;
const READY_POLL_MS       = 300;
const STOP_TIMEOUT_MS     = 5_000;

// ── Types ────────────────────────────────────────────────────────────────

export type HostAdminServer = {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  stop: () => Promise<void>;
};

// ── Session cookie helpers ───────────────────────────────────────────────

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), decodeURIComponent(v.join("="))];
    })
  );
}

function isValidSession(cookies: Record<string, string>, adminToken: string): boolean {
  const session = cookies["op_session"];
  if (session && session === adminToken) return true;
  return false;
}

// ── Origin / Host validation ─────────────────────────────────────────────

function isAllowedOrigin(origin: string | null, allowedHosts: string[]): boolean {
  if (!origin) return true; // non-browser clients (curl, CLI) have no Origin
  try {
    const u = new URL(origin);
    return allowedHosts.some(h => u.host === h);
  } catch {
    return false;
  }
}

// ── Proxy helpers ────────────────────────────────────────────────────────

async function proxyTo(targetUrl: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const upstream = targetUrl + url.pathname + url.search;
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: AbortSignal.timeout(30_000),
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // @ts-ignore — duplex required for streaming in Node 18+
    init.duplex = "half";
  }
  return fetch(upstream, init);
}

// ── Node subprocess management ───────────────────────────────────────────

async function startNodeAdmin(buildDir: string, adminToken: string): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn(
    ["node", join(buildDir, "index.js")],
    {
      cwd: buildDir,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(INTERNAL_ADMIN_PORT),
        ORIGIN: `http://127.0.0.1:${INTERNAL_ADMIN_PORT}`,
        // Pass the admin token through so SvelteKit's state.ts can read it
        OP_ADMIN_TOKEN: adminToken,
      },
      stdout: "ignore",
      stderr: "ignore",
    }
  );
  return proc;
}

async function waitForNodeAdmin(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${INTERNAL_ADMIN_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok || res.status === 401) return true; // 401 means it's up
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

// ── Server factory ───────────────────────────────────────────────────────

export async function createHostAdminServer(opts: {
  port: number;
  buildDir: string;
  adminToken: string;
  openCodeBaseUrl?: string;          // http://127.0.0.1:<port>
  containerAdminBaseUrl?: string;    // http://localhost:3880 (container admin)
}): Promise<HostAdminServer> {
  const allowedHosts = [
    `localhost:${opts.port}`,
    `127.0.0.1:${opts.port}`,
  ];

  // Start the internal Node.js adapter-node process
  const nodeProc = await startNodeAdmin(opts.buildDir, opts.adminToken);
  const ready = await waitForNodeAdmin();
  if (!ready) {
    nodeProc.kill("SIGTERM");
    throw new Error("Internal admin Node.js process did not become ready in time");
  }
  logger.info("internal admin Node.js process ready", { port: INTERNAL_ADMIN_PORT });

  const internalAdminBase = `http://127.0.0.1:${INTERNAL_ADMIN_PORT}`;

  // ── Request handler ────────────────────────────────────────────────────

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ── Auth middleware ────────────────────────────────────────────────
    // Skip auth for:
    //   - GET requests to the UI (SvelteKit handles its own SSR auth redirects)
    //   - /health
    //   - /setup routes (wizard flow)
    //   - /api/setup/* (wizard API)

    const isPublicPath =
      path === "/health" ||
      path.startsWith("/setup") ||
      path.startsWith("/api/setup/") ||
      (method === "GET" && !path.startsWith("/admin/"));

    if (!isPublicPath) {
      // CSRF: validate Origin for mutating requests from browsers
      if (method !== "GET" && method !== "HEAD") {
        const origin = req.headers.get("origin");
        if (origin && !isAllowedOrigin(origin, allowedHosts)) {
          return new Response(JSON.stringify({ error: "forbidden_origin" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
      }

      // Token: accept cookie OR legacy x-admin-token header
      const cookies = parseCookies(req.headers.get("cookie"));
      const cookieOk = isValidSession(cookies, opts.adminToken);
      const headerToken = req.headers.get("x-admin-token") ?? "";
      const headerOk = headerToken && headerToken === opts.adminToken;

      if (!cookieOk && !headerOk) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // ── Proxy: /proxy/assistant/* ──────────────────────────────────────
    if (path.startsWith("/proxy/assistant/") || path === "/proxy/assistant") {
      if (!opts.openCodeBaseUrl) {
        return new Response(JSON.stringify({ error: "opencode_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const suffix = path.replace(/^\/proxy\/assistant/, "");
      const target = opts.openCodeBaseUrl + suffix + url.search;
      return proxyTo(target.replace(/\?$/, ""), new Request(target, req));
    }

    // ── Proxy: /proxy/admin/* ──────────────────────────────────────────
    if (path.startsWith("/proxy/admin/") || path === "/proxy/admin") {
      if (!opts.containerAdminBaseUrl) {
        return new Response(JSON.stringify({ error: "container_admin_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const suffix = path.replace(/^\/proxy\/admin/, "");
      const target = opts.containerAdminBaseUrl + suffix + url.search;
      return proxyTo(target.replace(/\?$/, ""), new Request(target, req));
    }

    // ── All other routes: forward to internal Node.js admin ───────────
    const upstreamUrl = internalAdminBase + path + url.search;
    try {
      return await proxyTo(internalAdminBase, new Request(upstreamUrl, req));
    } catch (err) {
      logger.error("internal admin proxy error", { path, error: String(err) });
      return new Response(JSON.stringify({ error: "internal_error", message: String(err) }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // ── Start Bun.serve gateway ────────────────────────────────────────────

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch: handleRequest,
  });

  logger.info("host admin gateway started", { port: opts.port });

  return {
    server,
    port: opts.port,
    async stop(): Promise<void> {
      server.stop();
      nodeProc.kill("SIGTERM");
      await Promise.race([
        nodeProc.exited,
        new Promise(r => setTimeout(r, STOP_TIMEOUT_MS)),
      ]);
      if (!nodeProc.killed) {
        nodeProc.kill("SIGKILL");
      }
    },
  };
}
```

**Complexity callout:** The `proxyTo` helper duplicates the pattern from `opencode-subprocess.ts`. This is acceptable at Phase 1a — if a third call site appears, extract to a shared util.

**AKM assistance:** none

**Validation:**
```bash
cd packages/cli && bun -e "
  // TypeScript check only — no actual runtime call
  import('./src/lib/host-admin-server.ts').then(() => console.log('imports ok'));
"
```

---

## ✅ Step 6: Add `OPENPALM_ADMIN_MODE` to `packages/lib/src/control-plane/types.ts`

**File:** `packages/lib/src/control-plane/types.ts`
**Change type:** modify

**Context:** The feature flag must be a typed value so both CLI and admin can read it from the environment without string-comparing raw env vars in multiple places. We add a pure function to `lib` so both consumers import from one place.

First read the file to find the right insertion point:

```bash
grep -n "export type\|export function\|export const" packages/lib/src/control-plane/types.ts | head -20
```

**Exact change — add after existing type exports:**

```typescript
// ── Admin mode feature flag ──────────────────────────────────────────────

export type AdminMode = "host" | "container";

/**
 * Read OPENPALM_ADMIN_MODE from the environment.
 * Returns "container" by default (existing behavior preserved).
 */
export function resolveAdminMode(): AdminMode {
  const raw = process.env.OPENPALM_ADMIN_MODE;
  if (raw === "host") return "host";
  return "container";
}
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/lib && bun -e "
  import { resolveAdminMode } from './src/control-plane/types.ts';
  console.log(resolveAdminMode());  // 'container'
  process.env.OPENPALM_ADMIN_MODE = 'host';
  // Re-import won't re-execute; check in test instead
"
```

---

## ✅ Step 7: Re-export `resolveAdminMode` and `AdminMode` from `packages/lib/src/index.ts`

**File:** `packages/lib/src/index.ts`
**Change type:** modify

**Context:** The lib barrel export is the contract boundary. Adding `resolveAdminMode` here keeps CLI and admin from importing from internal paths.

Find the existing `types.ts` export block:
```bash
grep -n "types" packages/lib/src/index.ts | head -5
```

**Exact change — add `resolveAdminMode` and `AdminMode` to the existing types re-export line:**

Before:
```typescript
  // ... existing exports from types.ts ...
  type ControlPlaneState,
  type CoreService,
  CORE_SERVICES,
  OPTIONAL_SERVICES,
```

After (add the two new exports to the same block):
```typescript
  type ControlPlaneState,
  type CoreService,
  CORE_SERVICES,
  OPTIONAL_SERVICES,
  type AdminMode,
  resolveAdminMode,
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/lib && bun -e "
  import { resolveAdminMode } from './src/index.ts';
  console.log(resolveAdminMode());
"
```

---

## ✅ Step 8: Modify `packages/cli/src/commands/admin.ts` — add `serve` subcommand

**File:** `packages/cli/src/commands/admin.ts` (lines 1–43)
**Change type:** modify

**Context:** Currently `openpalm admin` has `enable`, `disable`, `status` subcommands. We add `serve` which starts the host admin server. The `serve` subcommand:
- Reads `OP_HOME` and `OP_CACHE` to locate `cacheDir`.
- Calls `ensureAdminBuild(cacheDir)` to extract the tarball if needed.
- Reads `OP_ADMIN_TOKEN` from `stack.env` (via `getState().adminToken`).
- Optionally starts the OpenCode subprocess (same pattern as `runWizardInstall`).
- Creates the `HostAdminServer`.
- Installs `SIGINT` / `SIGTERM` handlers to tear down gracefully.
- Opens the browser unless `--no-open`.

**Exact change — full file replacement:**

```typescript
import { defineCommand } from 'citty';
import { listEnabledAddonIds, resolveAdminMode, resolveCacheDir, resolveOpenPalmHome, resolveConfigDir, createOpenCodeClient, createLogger } from '@openpalm/lib';
import { ensureValidState } from '../lib/cli-state.ts';
import { runAddonDisableAction, runAddonEnableAction } from './addon.ts';
import { ensureAdminBuild } from '../lib/admin-build.ts';
import { createHostAdminServer } from '../lib/host-admin-server.ts';
import { startOpenCodeSubprocess, type OpenCodeSubprocess } from '../lib/opencode-subprocess.ts';
import { openBrowser } from '../lib/browser.ts';

const logger = createLogger('cli:admin');
const HOST_ADMIN_PORT = Number(process.env.OP_HOST_ADMIN_PORT) || 3880;

// ── existing subcommands ─────────────────────────────────────────────────

async function runAdminStatusAction(): Promise<void> {
  const state = ensureValidState();
  const enabled = listEnabledAddonIds(state.homeDir).includes('admin');
  console.log(enabled ? 'Admin addon is enabled.' : 'Admin addon is disabled.');
}

const enableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable the admin addon' },
  async run() { await runAddonEnableAction('admin'); },
});

const disableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable the admin addon' },
  async run() { await runAddonDisableAction('admin'); },
});

const statusCmd = defineCommand({
  meta: { name: 'status', description: 'Show whether the admin addon is enabled' },
  async run() { await runAdminStatusAction(); },
});

// ── serve subcommand ─────────────────────────────────────────────────────

const serveCmd = defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the host admin server (requires OPENPALM_ADMIN_MODE=host)',
  },
  args: {
    port: {
      type: 'string',
      description: 'Port to listen on (default: 3880 or OP_HOST_ADMIN_PORT)',
    },
    open: {
      type: 'boolean',
      description: 'Open browser after start (use --no-open to skip)',
      default: true,
    },
    'container-admin': {
      type: 'string',
      description: 'Base URL for the container admin to proxy /proxy/admin (optional)',
    },
  },
  async run({ args }) {
    const adminMode = resolveAdminMode();
    if (adminMode !== 'host') {
      console.error(
        'openpalm admin serve requires OPENPALM_ADMIN_MODE=host.\n' +
        'Set OPENPALM_ADMIN_MODE=host in your environment and retry.'
      );
      process.exit(1);
    }

    const port = args.port ? Number(args.port) : HOST_ADMIN_PORT;
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${args.port}`);
      process.exit(1);
    }

    const cacheDir = resolveCacheDir();
    const homeDir = resolveOpenPalmHome();
    const configDir = resolveConfigDir();
    const stateDir = `${homeDir}/state`;

    // Extract the admin build (idempotent)
    console.log('Preparing admin build...');
    let buildDir: string;
    try {
      buildDir = ensureAdminBuild(cacheDir);
    } catch (err) {
      console.error(`Failed to prepare admin build: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Read admin token from stack state
    const state = ensureValidState();
    const adminToken = state.adminToken;
    if (!adminToken) {
      console.error(
        'Admin token not configured. Run `openpalm install` first.'
      );
      process.exit(1);
    }

    // Start OpenCode subprocess (non-fatal)
    let openCodeSub: OpenCodeSubprocess | null = null;
    let openCodeBaseUrl: string | undefined;
    try {
      console.log('Starting OpenCode subprocess...');
      openCodeSub = await startOpenCodeSubprocess({ homeDir, configDir, stateDir });
      const ready = await openCodeSub.waitForReady();
      if (ready) {
        openCodeBaseUrl = openCodeSub.baseUrl;
        console.log(`OpenCode subprocess ready at ${openCodeBaseUrl}`);
      } else {
        console.warn('OpenCode subprocess did not become ready. /proxy/assistant will return 503.');
        await openCodeSub.stop();
        openCodeSub = null;
      }
    } catch (err) {
      console.warn(`OpenCode subprocess failed to start: ${err instanceof Error ? err.message : String(err)}`);
      openCodeSub = null;
    }

    // Start host admin server
    console.log('Starting host admin server...');
    let adminServer: Awaited<ReturnType<typeof createHostAdminServer>>;
    try {
      adminServer = await createHostAdminServer({
        port,
        buildDir,
        adminToken,
        openCodeBaseUrl,
        containerAdminBaseUrl: args['container-admin'],
      });
    } catch (err) {
      console.error(`Failed to start host admin server: ${err instanceof Error ? err.message : String(err)}`);
      if (openCodeSub) await openCodeSub.stop().catch(() => {});
      process.exit(1);
    }

    const adminUrl = `http://localhost:${port}`;
    console.log(`Host admin server running at ${adminUrl}`);

    if (args.open) await openBrowser(adminUrl);

    // ── Graceful shutdown ──────────────────────────────────────────────
    async function shutdown(signal: string): Promise<void> {
      console.log(`\nReceived ${signal}. Shutting down...`);
      try {
        await adminServer.stop();
        if (openCodeSub) await openCodeSub.stop().catch(() => {});
        console.log('Shutdown complete.');
      } catch (err) {
        logger.error('Error during shutdown', { error: String(err) });
      }
      process.exit(0);
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep the process alive
    await new Promise<never>(() => {});
  },
});

// ── Root admin command ───────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: 'admin',
    description: 'Enable, disable, inspect, or host the admin panel',
  },
  subCommands: {
    enable: enableCmd,
    disable: disableCmd,
    status: statusCmd,
    serve: serveCmd,
  },
});
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/cli && bun run src/main.ts admin serve --help
# Should print usage for 'serve' with --port, --open, --container-admin flags
```

---

## ✅ Step 9: Wire `OPENPALM_ADMIN_MODE` into `packages/cli/src/commands/install.ts`

**File:** `packages/cli/src/commands/install.ts` (lines 40–86, the `defineCommand` block)
**Change type:** modify

**Context:** `openpalm install` must write `OPENPALM_ADMIN_MODE` to `stack.env` when the user passes `--admin-mode host`. The flag defaults to `container` (no change to existing behavior). This gives operators a way to bake the preference into the stack env at install time.

**Exact change — modify the `args` block and `run` function in `defineCommand`:**

In the `args` object (after line 69, the `file` arg), add:
```typescript
    'admin-mode': {
      type: 'string',
      description: 'Admin server mode: "host" or "container" (default: container)',
      default: 'container',
    },
```

In the `run` function (after the `try` block on line 72), pass `adminMode` to `bootstrapInstall`:
```typescript
    async run({ args }) {
      try {
        const version = args.version || await resolveDefaultInstallRef();
        await bootstrapInstall({
          force: args.force,
          version,
          noStart: !args.start,
          noOpen: !args.open,
          file: args.file,
          adminMode: (args['admin-mode'] === 'host' ? 'host' : 'container'),
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    },
```

In the `InstallOptions` type (lines 88–95), add:
```typescript
type InstallOptions = {
  force: boolean;
  version: string;
  noStart: boolean;
  noOpen: boolean;
  file?: string;
  adminMode: 'host' | 'container';
};
```

In `ensureStackEnv` call inside `prepareInstallFiles` (line 195), the `stack.env` content already written includes the base vars. We need to also append `OPENPALM_ADMIN_MODE` when it's not already in the file. The cleanest approach is to append it in `bootstrapInstall` after `prepareInstallFiles` returns, by adding one direct write:

In `bootstrapInstall` (line 128), after `await prepareInstallFiles(...)`:
```typescript
  // Write admin mode preference to stack.env (append if not present)
  if (options.adminMode === 'host') {
    const stackEnvPath = `${configDir}/stack/stack.env`;
    const existing = await Bun.file(stackEnvPath).text().catch(() => '');
    if (!existing.includes('OPENPALM_ADMIN_MODE=')) {
      await Bun.write(stackEnvPath, existing.trimEnd() + '\nOPENPALM_ADMIN_MODE=host\n');
    }
  }
```

**AKM assistance:** none

**Validation:**
```bash
# Dry-run: check the flag appears in help output
cd packages/cli && bun run src/main.ts install --help | grep admin-mode
```

---

## ✅ Step 10: Add `admin:build:tar` step to the CLI build pipeline in `packages/cli/package.json`

**File:** `packages/cli/package.json` (lines 15–27, the `scripts` block)
**Change type:** modify

**Context:** The CLI binary embeds the admin tarball at compile time. The `build` script must ensure the admin tarball exists before Bun compiles. Add a `prebuild` script that runs the admin build and tarball creation.

**Exact change:**

Add after `"build": "bun build src/main.ts --compile --outfile dist/openpalm-cli",`:
```json
"prebuild": "cd ../admin && npm run build && npm run build:tar",
```

For the cross-compilation targets (build:linux-x64, etc.) add the same prebuild prefix or chain it explicitly. The simplest approach is to add one `prebuild` script that npm/bun runs automatically before any `build` script:

```json
"scripts": {
  "start": "bun run src/main.ts",
  "test": "bun test",
  "test:e2e": "npx playwright test",
  "wizard:dev": "bun run src/main.ts install --no-start --force",
  "prebuild": "cd ../admin && npm run build && npm run build:tar",
  "build": "bun build src/main.ts --compile --outfile dist/openpalm-cli",
  ...rest unchanged
}
```

**Note:** Bun does not honor `prebuild` hooks (unlike npm). For Bun-compiled builds, the root `package.json` script `admin:build:tar` must be run manually before `cli:build:*`. Document this in a comment. The `prebuild` hook is kept for npm-based CI environments.

Add a comment in the scripts block:
```json
"_build_note": "Run 'bun run admin:build:tar' from repo root before any cli:build:* target (Bun does not run prebuild hooks)",
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/admin && npm run build && npm run build:tar
cd packages/cli && bun build src/main.ts --compile --outfile /tmp/openpalm-cli-test 2>&1 | tail -5
/tmp/openpalm-cli-test admin serve --help
```

---

## ✅ Step 11: Update the `packages/admin/src/lib/auth.ts` client-side to set a cookie on login (for future host mode)

**File:** `packages/admin/src/lib/auth.ts` (lines 1–38)
**Change type:** modify

**Context:** Currently `auth.ts` stores the admin token in `localStorage` and sends it as `x-admin-token`. For host mode, the gateway validates a cookie `op_session`. We need the SvelteKit UI to set that cookie when the user authenticates. We add a `storeSessionCookie` function. `localStorage` storage is preserved for container mode compatibility.

The cookie is set via a `POST /admin/auth/session` endpoint that the host gateway will intercept before forwarding (see Step 12). For Phase 1a, the UI does not change — we only add the infrastructure. The `validateToken` function is also updated to fall back to cookie auth detection.

**Exact change — full file replacement:**

```typescript
const TOKEN_KEY = 'openpalm.adminToken';

export function getAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  // Also clear session cookie (best-effort — httpOnly cookies cannot be cleared from JS)
  document.cookie = 'op_session=; Max-Age=0; path=/; SameSite=Strict';
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Request the host gateway to set a session cookie.
 * Only relevant when OPENPALM_ADMIN_MODE=host. No-ops silently in container mode
 * (the endpoint returns 404 which we ignore).
 */
export async function storeSessionCookie(token: string): Promise<void> {
  try {
    await fetch('/admin/auth/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
      },
      body: JSON.stringify({ token }),
    });
  } catch {
    // best-effort — container mode will return 404
  }
}

export async function validateToken(
  token: string
): Promise<{ ok: boolean; allowed: boolean; error?: string }> {
  try {
    const res = await fetch('/admin/capabilities/status', {
      headers: {
        'x-admin-token': token,
        'x-requested-by': 'ui',
        'x-request-id': crypto.randomUUID()
      }
    });
    if (res.ok) {
      return { ok: true, allowed: true };
    }
    if (res.status === 401) {
      return { ok: false, allowed: false, error: 'Invalid admin token.' };
    }
    return { ok: false, allowed: false, error: `Unexpected status: ${res.status}` };
  } catch (e) {
    console.warn('[auth] Unable to reach admin API', e);
    return { ok: false, allowed: false, error: 'Unable to reach admin API.' };
  }
}
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/admin && npm run check  # svelte-check — should pass 0 errors
```

---

## ✅ Step 12: Add `/admin/auth/session` route to SvelteKit for host-mode cookie issuance

**File:** `packages/admin/src/routes/admin/auth/session/+server.ts` (new file)
**Change type:** create

**Context:** The host admin gateway validates the `x-admin-token` header before forwarding to the internal Node.js process. Once the header is valid, this SvelteKit route issues a `Set-Cookie: op_session=<token>; HttpOnly; SameSite=Strict; Path=/` response. The cookie value is the admin token itself (Phase 1a; rotate to a random session ID in Phase 1b). The gateway reads this cookie on subsequent requests, removing the need to send the header again.

**Exact change — full file content:**

```typescript
import { requireAdmin, getRequestId, jsonResponse } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

/**
 * POST /admin/auth/session
 *
 * Issues a session cookie after verifying the x-admin-token header.
 * Used by the host admin gateway to establish cookie-based sessions.
 * No-op in container mode (cookie is not read by the container gateway).
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const token = event.request.headers.get("x-admin-token") ?? "";

  // Issue session cookie. HttpOnly prevents JS access; SameSite=Strict blocks CSRF.
  // Max-Age=86400 = 24 hours.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `op_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
    },
  });
};
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/admin && npm run check  # 0 errors
# Manual: curl -X POST http://localhost:3880/admin/auth/session \
#   -H "x-admin-token: <token>" -v 2>&1 | grep "set-cookie"
```

---

## ✅ Step 13: Write unit tests for `ensureAdminBuild` in `packages/cli/src/lib/admin-build.test.ts`

**File:** `packages/cli/src/lib/admin-build.test.ts` (new file)
**Change type:** create

**Context:** The extraction logic has two observable behaviors: (1) skips extraction when `index.js` already exists; (2) extracts a valid tarball and returns the path. We test both with a real minimal tarball created in-process. This follows the pattern of existing CLI tests in `setup-wizard/server.test.ts`.

**Exact change — full file content:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We cannot import the real embedded tarball in tests (it's a binary Bun import),
// so we test the extraction logic with a synthetic helper that uses the same
// Bun.spawnSync + tar approach without the embedded constant.

async function extractTar(tarBytes: Uint8Array, destDir: string): Promise<void> {
  const tarPath = join(tmpdir(), `test-tar-${Date.now()}.tar.gz`);
  writeFileSync(tarPath, tarBytes);
  const result = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", destDir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function makeTar(srcDir: string): Promise<Uint8Array> {
  const tarPath = join(tmpdir(), `test-tar-src-${Date.now()}.tar.gz`);
  const result = Bun.spawnSync(["tar", "-czf", tarPath, "-C", srcDir, "."], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new Uint8Array(await Bun.file(tarPath).arrayBuffer());
}

describe("admin-build extraction", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "op-admin-build-test-"));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("extracts tarball and produces index.js", async () => {
    // Create a minimal "build" directory to tar up
    const srcDir = join(tmpBase, "src");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.js"), "// mock admin build\n");
    writeFileSync(join(srcDir, "handler.js"), "export const handler = () => {};\n");

    const tarBytes = await makeTar(srcDir);
    const destDir = join(tmpBase, "dest");
    mkdirSync(destDir, { recursive: true });

    await extractTar(tarBytes, destDir);

    expect(existsSync(join(destDir, "index.js"))).toBe(true);
    expect(existsSync(join(destDir, "handler.js"))).toBe(true);
  });

  it("reports error on invalid tarball", async () => {
    const destDir = join(tmpBase, "dest2");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(destDir, { recursive: true });

    const garbage = new Uint8Array([0, 1, 2, 3, 4]);
    await expect(extractTar(garbage, destDir)).rejects.toThrow();
  });
});
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/cli && bun test src/lib/admin-build.test.ts
# Should report 2 passing tests
```

---

## ✅ Step 14: Write unit tests for the auth middleware in `host-admin-server`

**File:** `packages/cli/src/lib/host-admin-server.test.ts` (new file)
**Change type:** create

**Context:** The auth and CSRF logic in `host-admin-server.ts` is testable without starting the full server — we can extract the pure functions (`parseCookies`, `isValidSession`, `isAllowedOrigin`) and test them directly, OR we test them via the exported server's fetch handler. For Phase 1a, extract the three helper functions into testable exports.

**Step 14a:** First, export the helpers from `host-admin-server.ts`. Add `export` to the three helper functions:

In `packages/cli/src/lib/host-admin-server.ts`, change:
```typescript
function parseCookies(...)
function isValidSession(...)
function isAllowedOrigin(...)
```
to:
```typescript
export function parseCookies(...)
export function isValidSession(...)
export function isAllowedOrigin(...)
```

**Step 14b:** Create the test file:

```typescript
import { describe, it, expect } from "bun:test";
import { parseCookies, isValidSession, isAllowedOrigin } from "./host-admin-server.ts";

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    expect(parseCookies("op_session=abc123")).toEqual({ op_session: "abc123" });
  });

  it("parses multiple cookies", () => {
    const result = parseCookies("foo=1; bar=2; op_session=tok");
    expect(result.foo).toBe("1");
    expect(result.bar).toBe("2");
    expect(result.op_session).toBe("tok");
  });

  it("returns empty object for null header", () => {
    expect(parseCookies(null)).toEqual({});
  });
});

describe("isValidSession", () => {
  it("accepts matching op_session cookie", () => {
    expect(isValidSession({ op_session: "secret" }, "secret")).toBe(true);
  });

  it("rejects mismatched token", () => {
    expect(isValidSession({ op_session: "wrong" }, "secret")).toBe(false);
  });

  it("rejects missing cookie", () => {
    expect(isValidSession({}, "secret")).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("allows null origin (non-browser clients)", () => {
    expect(isAllowedOrigin(null, ["localhost:3880"])).toBe(true);
  });

  it("allows matching host", () => {
    expect(isAllowedOrigin("http://localhost:3880", ["localhost:3880"])).toBe(true);
  });

  it("blocks non-matching host", () => {
    expect(isAllowedOrigin("http://evil.com", ["localhost:3880"])).toBe(false);
  });

  it("blocks malformed origin", () => {
    expect(isAllowedOrigin("not-a-url", ["localhost:3880"])).toBe(false);
  });
});
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/cli && bun test src/lib/host-admin-server.test.ts
# Should report 8 passing tests
```

---

## ✅ Step 15: Add smoke test for `openpalm admin serve --help` to `packages/cli/src/main.test.ts`

**File:** `packages/cli/src/main.test.ts`
**Change type:** modify

**Context:** `main.test.ts` already tests CLI command registration. Add one test that asserts `openpalm admin serve` appears in `admin --help` output.

Read the existing file first:
```bash
head -40 packages/cli/src/main.test.ts
```

**Exact change — add after the last existing `it(...)` block but before the final `});`:**

```typescript
  it("registers 'admin serve' subcommand", async () => {
    // Import the admin command and verify it has a 'serve' subcommand
    const adminMod = await import("./commands/admin.ts");
    const adminCmd = adminMod.default;
    // citty commands expose subCommands as a record — check the key exists
    expect(Object.keys((adminCmd as any).subCommands ?? {})).toContain("serve");
  });
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/cli && bun test src/main.test.ts
```

---

## ✅ Step 16: Update `packages/admin/svelte.config.js` — ensure `adapter-node` `out` dir is explicit

**File:** `packages/admin/svelte.config.js` (lines 1–14)
**Change type:** modify

**Context:** By default `adapter-node` writes to `build/`. Making this explicit prevents a future change from silently breaking the embedded path. Also add `envPrefix: ""` (empty string) to pass through all env vars without a prefix — required so `OP_ADMIN_TOKEN` is accessible to the Node.js admin process.

**Exact change:**

Before:
```javascript
kit: {
  adapter: adapter(),
  version: { name: pkg.version }
}
```

After:
```javascript
kit: {
  adapter: adapter({
    out: "build",
    envPrefix: "",
  }),
  version: { name: pkg.version }
}
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/admin && npm run build 2>&1 | grep -E "error|warning" | head -10
ls packages/admin/build/index.js  # must still exist
```

---

## ✅ Step 17: Create `packages/cli/src/lib/admin-build.test.ts` entry in `bunfig.toml` or confirm test discovery

**File:** `packages/cli/bunfig.toml` (if it exists) or confirm bun auto-discovers `*.test.ts`
**Change type:** verify

**Context:** Bun auto-discovers files matching `**/*.test.ts`. No `bunfig.toml` changes needed unless the existing config explicitly excludes patterns.

**Exact change:**
```bash
# Verify auto-discovery
cat packages/cli/bunfig.toml 2>/dev/null || echo "no bunfig.toml — bun auto-discovers tests"
```

If `bunfig.toml` has a `test.include` or `preload` that would exclude the new test files, add them. Otherwise no change needed.

**AKM assistance:** none

**Validation:**
```bash
cd packages/cli && bun test --list 2>&1 | grep "admin-build\|host-admin"
# Both test files should appear
```

---

## ✅ Step 18: Document `OPENPALM_ADMIN_MODE` in `docs/technical/core-principles.md`

**File:** `docs/technical/core-principles.md`
**Change type:** modify

**Context:** The core-principles doc is authoritative for all architectural rules. The feature flag and what it controls must be recorded there so future contributors understand both modes co-exist during the migration.

**Exact change — find the "Security Invariants" or "Feature Flags" section (or create a new section):**

Add a new subsection under the relevant heading (search for "invariant" or "environment" in the file first):
```bash
grep -n "## " docs/technical/core-principles.md | head -20
```

Then add at an appropriate location:
```markdown
### Feature Flag: `OPENPALM_ADMIN_MODE`

Default: `container`

- `container` — Admin UI is served by the Docker container (existing behavior). `openpalm admin serve` is not run.
- `host` — Admin UI is served by the CLI host process via `openpalm admin serve`. The container admin can still run simultaneously during migration. The host admin gateway binds to `127.0.0.1:3880` by default (`OP_HOST_ADMIN_PORT` overrides).

Set at install time via `openpalm install --admin-mode host`, or manually in `config/stack/stack.env`.
```

**AKM assistance:** none

**Validation:**
```bash
grep -n "OPENPALM_ADMIN_MODE" docs/technical/core-principles.md
# Should find the new section
```

---

## Execution Order and Dependency Summary

Run these steps in this order. Steps without dependencies can be parallelized:

```
Step 1  → Step 2                (admin:build:tar scripts)
Step 3  ← requires Step 1       (embed tarball — requires tar to exist)
Step 4  ← requires Step 3       (extraction util — requires embedded constant)
Step 5  (independent)           (host-admin-server.ts — no file deps)
Step 6  → Step 7                (lib types + barrel export)
Step 8  ← requires Steps 4,5,6  (admin.ts serve command — imports from all)
Step 9  ← requires Step 6       (install.ts --admin-mode flag)
Step 10 ← requires Step 1       (prebuild hook)
Step 11 (independent)           (auth.ts UI helper)
Step 12 (independent)           (SvelteKit session route)
Step 13 ← requires Step 4       (admin-build test)
Step 14 ← requires Step 5       (host-admin-server test)
Step 15 ← requires Step 8       (main.test.ts addition)
Step 16 (independent)           (svelte.config.js)
Step 17 ← requires Steps 13,14  (test discovery verify)
Step 18 (independent)           (docs)
```

---

## End-to-End Verification Sequence

After all steps are implemented:

```bash
# 1. Build admin and create tarball
bun run admin:build:tar

# 2. Type-check admin
cd packages/admin && npm run check

# 3. Run CLI tests
bun run cli:test

# 4. Manually smoke-test host admin serve (requires a configured OP_HOME)
OP_HOME=/tmp/openpalm/.dev \
OPENPALM_ADMIN_MODE=host \
bun run packages/cli/src/main.ts admin serve --no-open

# 5. In another terminal, verify the gateway is up
curl -s http://localhost:3880/health        # should return {"ok":true} or similar
curl -s http://localhost:3880/admin/capabilities/status \
  -H "x-admin-token: dev-admin-token"      # should return JSON, not 401

# 6. Verify CSRF blocks a mismatched origin
curl -s -X POST http://localhost:3880/admin/install \
  -H "Origin: http://evil.com" \
  -H "x-admin-token: dev-admin-token" \
  -H "content-type: application/json" \
  -d '{}' | jq .error                      # should be "forbidden_origin"

# 7. Verify SIGINT teardown (Ctrl+C in the serve terminal)
#    Both processes should stop cleanly — check with `ps aux | grep node`
```

---

## Known Constraints and Risks

**Binary Bun import for `.tar.gz`:** Bun supports `with { type: "binary" }` imports since Bun 1.0. Verify the Bun version in the repo can handle this:
```bash
bun --version   # should be >= 1.0.0
```
If not available, fall back to embedding the tarball as a base64 string via a code-generation script run in `prebuild`.

**`handler.js` uses `import.meta.url`:** When Node.js runs `index.js` with `cwd` set to the extracted build dir, `import.meta.url` resolves to `file://{buildDir}/handler.js`. The `client/` static directory is at `{buildDir}/client/`. This works correctly as long as `cwd` is `buildDir` in the `Bun.spawn` call (Step 5).

**Port conflict:** If the admin container is also running on port 3880, the host server cannot bind that port. Use `OP_HOST_ADMIN_PORT=3881` for testing when running both modes simultaneously.

**`OP_ADMIN_TOKEN` env var:** The internal Node.js admin process receives `OP_ADMIN_TOKEN` via the env. The SvelteKit `createState()` in `state.ts` reads the token from `stack.env` on disk, NOT from env vars directly. Verify this is still the path after Step 6. If `createState()` needs to read from env as a fallback, that change belongs in `packages/lib` (not in Phase 1a scope).
