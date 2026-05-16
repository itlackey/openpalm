/**
 * Host admin server.
 *
 * Spawns the SvelteKit adapter-node build (index.js) as a Node.js child
 * process bound to an internal loopback port, then exposes it through a
 * Bun.serve gateway that adds:
 *   - Origin / Host header validation (CSRF)
 *   - Cookie session auth (op_session) + legacy x-admin-token support
 *   - /proxy/assistant → OpenCode subprocess
 *   - /proxy/admin     → host admin OpenCode subprocess
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

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), decodeURIComponent(v.join("="))];
    })
  );
}

export function isValidSession(cookies: Record<string, string>, adminToken: string): boolean {
  const session = cookies["op_session"];
  if (session && session === adminToken) return true;
  return false;
}

// ── Origin / Host validation ─────────────────────────────────────────────

export function isAllowedOrigin(origin: string | null, allowedHosts: string[]): boolean {
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
