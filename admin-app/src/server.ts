import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { classifyPluginRisk, preflightPlugin, updatePluginListAtomically, validatePluginIdentifier } from "./extensions.ts";
import { classifyBundleRisk, collectBundleMetrics, prepareBundleRegistry, registerBundleState, snapshotFile, validateBundle } from "./change-manager.ts";
import { parseJsonc, stringifyPretty } from "./jsonc.ts";
import { ExtensionQueue } from "./admin-store.ts";
import type { ExtensionRequest } from "./types.ts";

const PORT = Number(Bun.env.PORT ?? 8100);
const ADMIN_TOKEN = Bun.env.ADMIN_TOKEN ?? "change-me-admin-token";
const ADMIN_STEP_UP_TOKEN = Bun.env.ADMIN_STEP_UP_TOKEN ?? "change-me-step-up";
const OPENCODE_CONFIG_PATH = Bun.env.OPENCODE_CONFIG_PATH ?? "/app/config/opencode.jsonc";
const CHANGE_BUNDLE_DIR = Bun.env.CHANGE_BUNDLE_DIR ?? "/app/data/bundles";
const CHANGE_STATE_DIR = Bun.env.CHANGE_STATE_DIR ?? "/app/data/change-states";
const EXT_REQUESTS_PATH = Bun.env.EXT_REQUESTS_PATH ?? "/app/data/extension-requests.json";
const CONTROLLER_URL = Bun.env.CONTROLLER_URL;
const CONTROLLER_TOKEN = Bun.env.CONTROLLER_TOKEN ?? "";
const CADDY_ADMIN_URL = Bun.env.CADDY_ADMIN_URL ?? "";
const AUTO_APPROVE_EXTENSIONS = (Bun.env.AUTO_APPROVE_EXTENSIONS ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const extQueue = new ExtensionQueue(EXT_REQUESTS_PATH);
prepareBundleRegistry(CHANGE_STATE_DIR);

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { "content-type": "application/json" } });
}

function auth(req: Request) {
  return req.headers.get("x-admin-token") === ADMIN_TOKEN;
}

function stepUp(req: Request) {
  return req.headers.get("x-admin-step-up") === ADMIN_STEP_UP_TOKEN;
}

async function controllerAction(action: string, service: string, reason: string) {
  if (!CONTROLLER_URL) return;
  await fetch(`${CONTROLLER_URL}/${action}/${service}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-controller-token": CONTROLLER_TOKEN
    },
    body: JSON.stringify({ reason })
  });
}

function updateConfigAtomically(mutator: (raw: string) => string) {
  const raw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
  const backup = snapshotFile(OPENCODE_CONFIG_PATH);
  writeFileSync(OPENCODE_CONFIG_PATH, mutator(raw), "utf8");
  return { backup };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    try {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health" && req.method === "GET") {
        return json(200, { ok: true, service: "admin-app", time: new Date().toISOString() });
      }

      // --- Container management ---
      if (url.pathname === "/admin/containers/list" && req.method === "GET") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!CONTROLLER_URL) return json(503, { error: "controller not configured" });
        const resp = await fetch(`${CONTROLLER_URL}/containers`, {
          headers: { "x-controller-token": CONTROLLER_TOKEN }
        });
        return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
      }

      if (url.pathname === "/admin/containers/up" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { service: string };
        await controllerAction("up", body.service, "admin-app action");
        return json(200, { ok: true, action: "up", service: body.service });
      }

      if (url.pathname === "/admin/containers/down" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { service: string };
        await controllerAction("down", body.service, "admin-app action");
        return json(200, { ok: true, action: "down", service: body.service });
      }

      if (url.pathname === "/admin/containers/restart" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { service: string };
        await controllerAction("restart", body.service, "admin-app action");
        return json(200, { ok: true, action: "restart", service: body.service });
      }

      // --- Extension lifecycle ---
      if (url.pathname === "/admin/extensions/request" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        const body = (await req.json()) as { pluginId: string; sourceType?: "npm" | "local"; requestedBy?: string };
        if (!validatePluginIdentifier(body.pluginId)) return json(400, { error: "invalid plugin id" });

        const risk = classifyPluginRisk(body.pluginId);
        const preflight = await preflightPlugin(body.pluginId);
        if (!preflight.ok) return json(400, { error: "preflight_failed", details: preflight.details });

        const autoApproved = AUTO_APPROVE_EXTENSIONS.includes(body.pluginId) && risk !== "critical";
        const item = extQueue.upsert({
          id: randomUUID(),
          pluginId: body.pluginId,
          sourceType: body.sourceType ?? (body.pluginId.startsWith("./") ? "local" : "npm"),
          requestedAt: new Date().toISOString(),
          requestedBy: body.requestedBy ?? "admin",
          status: autoApproved ? "approved" : "pending",
          risk,
          reason: autoApproved ? "policy-auto-approved" : "requires_step_up_apply"
        });

        if (autoApproved) {
          const applied = updatePluginListAtomically(OPENCODE_CONFIG_PATH, item.pluginId, true);
          await controllerAction("restart", "opencode", "auto-approved extension");
          item.status = "applied";
          extQueue.upsert(item);
          return json(200, { ok: true, item, applied });
        }
        return json(202, { ok: true, item, next: "POST /admin/extensions/apply" });
      }

      if (url.pathname === "/admin/extensions/list" && req.method === "GET") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        return json(200, { items: extQueue.list() });
      }

      if (url.pathname === "/admin/extensions/apply" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { requestId: string };
        const ext = extQueue.get(body.requestId);
        if (!ext) return json(404, { error: "request_not_found" });
        if (ext.status !== "pending" && ext.status !== "approved") return json(400, { error: "invalid_state", status: ext.status });

        const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, ext.pluginId, true);
        await controllerAction("restart", "opencode", "extension applied");
        ext.status = "applied";
        extQueue.upsert(ext);
        return json(200, { ok: true, ext, result });
      }

      if (url.pathname === "/admin/extensions/disable" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { pluginId: string };
        if (!validatePluginIdentifier(body.pluginId)) return json(400, { error: "invalid plugin id" });
        const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, body.pluginId, false);
        await controllerAction("restart", "opencode", "extension disabled");
        return json(200, { ok: true, action: "disabled", result });
      }

      // --- Config editor ---
      if (url.pathname === "/admin/config" && req.method === "GET") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        return new Response(readFileSync(OPENCODE_CONFIG_PATH, "utf8"), { headers: { "content-type": "text/plain" } });
      }

      if (url.pathname === "/admin/config" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { config: string; restart?: boolean };
        const parsed = parseJsonc(body.config);
        if (typeof parsed !== "object") return json(400, { error: "invalid jsonc" });
        const permissions = (parsed as Record<string, unknown>).permission as Record<string, string> | undefined;
        if (permissions && Object.values(permissions).some((v) => v === "allow")) return json(400, { error: "policy lint failed: permission widening blocked" });

        const backup = snapshotFile(OPENCODE_CONFIG_PATH);
        writeFileSync(OPENCODE_CONFIG_PATH, body.config, "utf8");
        if (body.restart ?? true) await controllerAction("restart", "opencode", "config update");
        return json(200, { ok: true, backup });
      }

      // --- Change manager ---
      if (url.pathname === "/admin/change/propose" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        const body = (await req.json()) as { bundleId: string };
        const path = `${CHANGE_BUNDLE_DIR}/${body.bundleId}`;
        if (!existsSync(path)) return json(404, { error: "bundle not found" });
        const metrics = collectBundleMetrics(path);
        const stateId = registerBundleState(CHANGE_STATE_DIR, { id: body.bundleId, stage: "proposed", createdAt: new Date().toISOString(), metrics });
        return json(200, { ok: true, stateId, metrics });
      }

      if (url.pathname === "/admin/change/validate" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        const body = (await req.json()) as { bundleId: string };
        const path = `${CHANGE_BUNDLE_DIR}/${body.bundleId}`;
        const valid = validateBundle(path);
        const risk = classifyBundleRisk(path);
        const stateId = registerBundleState(CHANGE_STATE_DIR, { id: body.bundleId, stage: "validated", valid, risk, validatedAt: new Date().toISOString() });
        return json(valid.ok ? 200 : 400, { ok: valid.ok, stateId, risk, ...valid });
      }

      if (url.pathname === "/admin/change/apply" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { bundleId: string; applyPlugins?: string[]; restart?: boolean };
        const path = `${CHANGE_BUNDLE_DIR}/${body.bundleId}`;
        const valid = validateBundle(path);
        if (!valid.ok) return json(400, { ok: false, errors: valid.errors });

        const outcome = updateConfigAtomically((raw) => {
          const doc = parseJsonc(raw) as { plugin?: string[] } & Record<string, unknown>;
          const plugins = new Set(Array.isArray(doc.plugin) ? doc.plugin : []);
          for (const p of body.applyPlugins ?? []) plugins.add(p);
          return stringifyPretty({ ...doc, plugin: [...plugins] });
        });

        registerBundleState(CHANGE_STATE_DIR, { id: body.bundleId, stage: "applied", backup: outcome.backup, appliedAt: new Date().toISOString() });
        if (body.restart ?? true) await controllerAction("restart", "opencode", "change bundle applied");
        return json(200, { ok: true, backup: outcome.backup });
      }

      if (url.pathname === "/admin/change/rollback" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { backupPath: string; restart?: boolean };
        const backup = readFileSync(body.backupPath, "utf8");
        writeFileSync(OPENCODE_CONFIG_PATH, backup, "utf8");
        if (body.restart ?? true) await controllerAction("restart", "opencode", "config rollback");
        return json(200, { ok: true, restoredFrom: body.backupPath });
      }

      // --- Admin UI ---
      if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
        return new Response(Bun.file("/app/admin-ui/index.html"));
      }

      return json(404, { error: "not_found" });
    } catch (error) {
      return json(500, { error: "internal_error", requestId });
    }
  }
});

console.log(JSON.stringify({ kind: "startup", service: "admin-app", port: server.port }));
