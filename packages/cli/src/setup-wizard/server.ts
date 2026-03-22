/**
 * CLI setup wizard HTTP server.
 *
 * Serves the setup wizard UI and provides API endpoints for provider detection,
 * model listing, and setup completion. Runs temporarily during `openpalm install`,
 * blocking until the user completes the wizard.
 *
 * Uses Bun.serve() with a fetch handler for routing.
 */
import {
  type SetupSpec,
  type SetupResult,
  type CoreAssetProvider,
  performSetup,
  detectLocalProviders,
  isSetupComplete,
  fetchProviderModels,
  resolveConfigDir,
  resolveVaultDir,
  FilesystemAssetProvider,
  resolveOpenPalmHome,
} from "@openpalm/lib";

// ── Types ────────────────────────────────────────────────────────────────

type DeployStatusEntry = {
  service: string;
  status: "pending" | "pulling" | "ready" | "running" | "error";
  label: string;
};

type SetupServerState = {
  setupComplete: boolean;
  setupResult: SetupResult | null;
  deployStatus: DeployStatusEntry[];
  deployError: string | null;
};

// ── JSON Response Helpers ────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { ok: false, error: code, message });
}

// ── Route Matching ───────────────────────────────────────────────────────

/**
 * Match a URL path against a pattern with `:param` segments.
 * Returns the matched params or null if no match.
 */
function matchRoute(
  path: string,
  pattern: string
): Record<string, string> | null {
  const pathSegments = path.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);

  if (pathSegments.length !== patternSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patSeg = patternSegments[i];
    if (patSeg.startsWith(":")) {
      params[patSeg.slice(1)] = decodeURIComponent(pathSegments[i]);
    } else if (patSeg !== pathSegments[i]) {
      return null;
    }
  }
  return params;
}

// ── Server Factory ───────────────────────────────────────────────────────

export type SetupServer = {
  server: ReturnType<typeof Bun.serve>;
  waitForComplete: () => Promise<SetupResult>;
  stop: () => void;
  /** Update deploy status for a service (for progress tracking). */
  updateDeployStatus: (entries: DeployStatusEntry[]) => void;
  setDeployError: (error: string) => void;
  markAllRunning: () => void;
};

/**
 * Create and start the setup wizard HTTP server.
 *
 * @param port - Port to listen on (default 8100)
 * @param opts - Optional overrides for asset provider and config dir
 */
export function createSetupServer(
  port: number = 8100,
  opts?: {
    assetProvider?: CoreAssetProvider;
    configDir?: string;
  }
): SetupServer {
  const configDir = opts?.configDir ?? resolveConfigDir();
  const assetProvider = opts?.assetProvider ?? new FilesystemAssetProvider(resolveOpenPalmHome());

  // Mutable server state
  const state: SetupServerState = {
    setupComplete: false,
    setupResult: null,
    deployStatus: [],
    deployError: null,
  };

  // Completion signal: resolves when setup POST succeeds
  let resolveComplete: ((result: SetupResult) => void) | null = null;
  const completionPromise = new Promise<SetupResult>((resolve) => {
    resolveComplete = resolve;
  });

  // ── Request Handler ──────────────────────────────────────────────────

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ── Static Assets ────────────────────────────────────────────────

    if (method === "GET" && (path === "/setup" || path === "/setup/")) {
      return new Response(WIZARD_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (method === "GET" && path === "/setup/wizard.js") {
      return new Response(WIZARD_JS, {
        status: 200,
        headers: { "Content-Type": "application/javascript; charset=utf-8" },
      });
    }

    if (method === "GET" && path === "/setup/wizard.css") {
      return new Response(WIZARD_CSS, {
        status: 200,
        headers: { "Content-Type": "text/css; charset=utf-8" },
      });
    }

    // ── API: Setup Status ────────────────────────────────────────────

    if (method === "GET" && path === "/api/setup/status") {
      const vaultDir = resolveVaultDir();
      const complete = isSetupComplete(vaultDir);
      return jsonResponse(200, {
        ok: true,
        setupComplete: complete || state.setupComplete,
      });
    }

    // ── API: Detect Providers ────────────────────────────────────────

    if (method === "GET" && path === "/api/setup/detect-providers") {
      try {
        const providers = await detectLocalProviders();
        return jsonResponse(200, { ok: true, providers });
      } catch (err) {
        return errorResponse(500, "detection_failed", String(err));
      }
    }

    // ── API: Fetch Models for a Provider ─────────────────────────────
    // Uses POST to keep API keys out of URLs/query strings.

    const modelsMatch = matchRoute(path, "/api/setup/models/:provider");
    if (method === "POST" && modelsMatch) {
      const provider = modelsMatch.provider;

      let reqBody: Record<string, unknown> = {};
      try {
        reqBody = (await req.json()) as Record<string, unknown>;
      } catch {
        return errorResponse(400, "invalid_json", "Request body must be valid JSON");
      }

      const apiKey = typeof reqBody.apiKey === "string" ? reqBody.apiKey : "";
      const baseUrl = typeof reqBody.baseUrl === "string" ? reqBody.baseUrl : "";

      try {
        const result = await fetchProviderModels(provider, apiKey, baseUrl, configDir);
        if (result.status !== "ok") {
          return jsonResponse(502, { ok: false, ...result });
        }
        return jsonResponse(200, { ok: true, ...result });
      } catch (err) {
        return errorResponse(500, "model_fetch_failed", String(err));
      }
    }

    // ── API: Complete Setup ──────────────────────────────────────────

    if (method === "POST" && path === "/api/setup/complete") {
      // Allow re-running if deploy failed (user clicked retry)
      if (state.setupComplete && !state.deployError) {
        return jsonResponse(200, { ok: true, message: "Setup already complete" });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return errorResponse(400, "invalid_json", "Request body must be valid JSON");
      }

      const setupSpec = body as SetupSpec;
      let result: SetupResult;
      try {
        result = await performSetup(setupSpec, assetProvider);
      } catch (err) {
        return errorResponse(500, "setup_failed", String(err));
      }

      if (result.ok) {
        state.setupComplete = true;
        state.setupResult = result;
        // Reset deploy state for fresh polling
        state.deployStatus = [];
        state.deployError = null;
        // Signal completion
        resolveComplete?.(result);
      }

      return jsonResponse(result.ok ? 200 : 400, result);
    }

    // ── API: Deploy Status ───────────────────────────────────────────

    if (method === "GET" && path === "/api/setup/deploy-status") {
      return jsonResponse(200, {
        ok: true,
        setupComplete: state.setupComplete,
        deployStatus: state.deployStatus,
        deployError: state.deployError,
      });
    }

    // ── 404 ──────────────────────────────────────────────────────────

    return errorResponse(404, "not_found", `Route not found: ${method} ${path}`);
  }

  // ── Start Server ─────────────────────────────────────────────────────

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: handleRequest,
  });

  return {
    server,
    waitForComplete: () => completionPromise,
    stop: () => server.stop(),
    updateDeployStatus: (entries: DeployStatusEntry[]) => {
      state.deployStatus = entries;
    },
    setDeployError: (error: string) => {
      state.deployError = error;
    },
    markAllRunning: () => {
      for (const entry of state.deployStatus) {
        if (entry.status !== "error") {
          entry.status = "running";
        }
      }
    },
  };
}

// ── Convenience: Wait for Setup Complete ─────────────────────────────────

/**
 * High-level helper: starts the server, waits for setup to complete, then stops.
 */
export async function waitForSetupComplete(
  port: number = 8100,
  opts?: {
    assetProvider?: CoreAssetProvider;
    configDir?: string;
  }
): Promise<SetupResult> {
  const { server, waitForComplete, stop } = createSetupServer(port, opts);
  try {
    return await waitForComplete();
  } finally {
    stop();
  }
}

// ── Static Assets (wizard UI from task 2.1) ─────────────────────────────
// Embedded at build time via Bun text imports from sibling files.

import WIZARD_HTML from "./index.html" with { type: "text" };
import WIZARD_JS from "./wizard.js" with { type: "text" };
import WIZARD_CSS from "./wizard.css" with { type: "text" };
