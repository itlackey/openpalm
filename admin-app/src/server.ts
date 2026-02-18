import { readFileSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { updatePluginListAtomically, validatePluginIdentifier } from "./extensions.ts";
import { parseJsonc, stringifyPretty } from "./jsonc.ts";
import { searchGallery, getGalleryItem, listGalleryCategories, searchNpm, getRiskBadge } from "./gallery.ts";
import { SetupManager } from "./setup.ts";
import { CronStore, validateCron } from "./cron-store.ts";
import type { GalleryCategory } from "./gallery.ts";

const PORT = Number(Bun.env.PORT ?? 8100);
const ADMIN_TOKEN = Bun.env.ADMIN_TOKEN ?? "change-me-admin-token";
const OPENCODE_CONFIG_PATH = Bun.env.OPENCODE_CONFIG_PATH ?? "/app/config/opencode.jsonc";
const DATA_DIR = "/app/data";
const CONTROLLER_URL = Bun.env.CONTROLLER_URL;
const CONTROLLER_TOKEN = Bun.env.CONTROLLER_TOKEN ?? "";
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const CADDYFILE_PATH = Bun.env.CADDYFILE_PATH ?? "/app/config/Caddyfile";
const CHANNEL_ENV_DIR = Bun.env.CHANNEL_ENV_DIR ?? "/app/channel-env";
const OPENCODE_CORE_URL = Bun.env.OPENCODE_CORE_URL ?? "http://opencode-core:4096";
const OPENCODE_CORE_CONFIG_DIR = Bun.env.OPENCODE_CORE_CONFIG_DIR ?? "/app/config/opencode-core";
const CHANNEL_SERVICES = ["channel-chat", "channel-discord", "channel-voice", "channel-telegram"] as const;
const CHANNEL_ENV_KEYS: Record<string, string[]> = {
  "channel-chat": ["CHAT_INBOUND_TOKEN"],
  "channel-discord": ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY"],
  "channel-voice": [],
  "channel-telegram": ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN"]
};

const setupManager = new SetupManager(DATA_DIR);
const cronStore = new CronStore(DATA_DIR, OPENCODE_CORE_CONFIG_DIR);

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function cors(resp: Response): Response {
  resp.headers.set("access-control-allow-origin", "*");
  resp.headers.set("access-control-allow-headers", "content-type, x-admin-token, x-request-id");
  resp.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return resp;
}

function auth(req: Request) {
  return req.headers.get("x-admin-token") === ADMIN_TOKEN;
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

function snapshotFile(path: string) {
  const backup = `${path}.${Date.now()}.bak`;
  copyFileSync(path, backup);
  return backup;
}



function channelRewritePath(channel: "chat" | "voice" | "discord" | "telegram") {
  if (channel === "chat") return "/chat";
  if (channel === "voice") return "/voice/transcription";
  if (channel === "discord") return "/discord/webhook";
  return "/telegram/webhook";
}

function channelPort(channel: "chat" | "voice" | "discord" | "telegram") {
  if (channel === "chat") return "8181";
  if (channel === "voice") return "8183";
  if (channel === "discord") return "8184";
  return "8182";
}

function detectChannelAccess(channel: "chat" | "voice" | "discord" | "telegram"): "lan" | "public" {
  const raw = readFileSync(CADDYFILE_PATH, "utf8");
  const block = raw.match(new RegExp(`handle \/channels\/${channel}\* \{[\s\S]*?\n\}`, "m"))?.[0] ?? "";
  return block.includes("abort @not_lan") ? "lan" : "public";
}

function setChannelAccess(channel: "chat" | "voice" | "discord" | "telegram", access: "lan" | "public") {
  const raw = readFileSync(CADDYFILE_PATH, "utf8");
  const blockRegex = new RegExp(`handle \/channels\/${channel}\* \{[\s\S]*?\n\}`, "m");
  const replacement = access === "lan"
    ? [
      `handle /channels/${channel}* {`,
      `		abort @not_lan`,
      `		rewrite * ${channelRewritePath(channel)}`,
      `		reverse_proxy channel-${channel}:${channelPort(channel)}`,
      `	}`
    ].join("\n")
    : [
      `handle /channels/${channel}* {`,
      `		rewrite * ${channelRewritePath(channel)}`,
      `		reverse_proxy channel-${channel}:${channelPort(channel)}`,
      `	}`
    ].join("\n");

  if (!blockRegex.test(raw)) throw new Error(`missing_${channel}_route_block`);
  writeFileSync(CADDYFILE_PATH, raw.replace(blockRegex, replacement), "utf8");
}

function channelEnvPath(service: string) {
  return `${CHANNEL_ENV_DIR}/${service}.env`;
}

function readChannelConfig(service: string) {
  const keys = CHANNEL_ENV_KEYS[service] ?? [];
  const path = channelEnvPath(service);
  const cfg: Record<string, string> = {};
  for (const k of keys) cfg[k] = "";
  if (!existsSync(path)) return cfg;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    if (keys.includes(k.trim())) cfg[k.trim()] = rest.join("=").trim();
  }
  return cfg;
}

function writeChannelConfig(service: string, values: Record<string, string>) {
  const keys = CHANNEL_ENV_KEYS[service] ?? [];
  const lines = ["# Channel-specific overrides managed by admin UI"];
  for (const k of keys) {
    const v = String(values[k] ?? "").replace(/\n/g, "").trim();
    lines.push(`${k}=${v}`);
  }
  writeFileSync(channelEnvPath(service), lines.join("\n") + "\n", "utf8");
}

async function checkServiceHealth(url: string): Promise<{ ok: boolean; time?: string; error?: string }> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { ok: false, error: `status ${resp.status}` };
    const body = await resp.json() as { ok?: boolean; time?: string };
    return { ok: body.ok ?? true, time: body.time };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    try {
      const url = new URL(req.url);

      // ── Health ────────────────────────────────────────────────────
      if (url.pathname === "/health" && req.method === "GET") {
        return cors(json(200, { ok: true, service: "admin-app", time: new Date().toISOString() }));
      }

      // ── Setup wizard ──────────────────────────────────────────────
      if (url.pathname === "/admin/setup/status" && req.method === "GET") {
        const state = setupManager.getState();
        return cors(json(200, { ...state, firstBoot: setupManager.isFirstBoot() }));
      }

      if (url.pathname === "/admin/setup/step" && req.method === "POST") {
        const body = (await req.json()) as { step: string };
        const validSteps = ["welcome", "healthCheck", "security", "channels", "extensions"];
        if (!validSteps.includes(body.step)) return cors(json(400, { error: "invalid step" }));
        const state = setupManager.completeStep(body.step as "welcome" | "healthCheck" | "security" | "channels" | "extensions");
        return cors(json(200, { ok: true, state }));
      }

      if (url.pathname === "/admin/setup/complete" && req.method === "POST") {
        const state = setupManager.completeSetup();
        return cors(json(200, { ok: true, state }));
      }

      if (url.pathname === "/admin/setup/health-check" && req.method === "GET") {
        const [gateway, controller] = await Promise.all([
          checkServiceHealth(`${GATEWAY_URL}/health`),
          CONTROLLER_URL ? checkServiceHealth(`${CONTROLLER_URL}/health`) : Promise.resolve({ ok: false, error: "not configured" })
        ]);
        return cors(json(200, {
          services: {
            gateway,
            controller,
            adminApp: { ok: true, time: new Date().toISOString() }
          }
        }));
      }

      // ── Gallery ───────────────────────────────────────────────────
      if (url.pathname === "/admin/gallery/search" && req.method === "GET") {
        const query = url.searchParams.get("q") ?? "";
        const category = url.searchParams.get("category") as GalleryCategory | null;
        const items = searchGallery(query, category ?? undefined);
        return cors(json(200, { items, total: items.length }));
      }

      if (url.pathname === "/admin/gallery/categories" && req.method === "GET") {
        return cors(json(200, { categories: listGalleryCategories() }));
      }

      if (url.pathname.startsWith("/admin/gallery/item/") && req.method === "GET") {
        const id = url.pathname.replace("/admin/gallery/item/", "");
        const item = getGalleryItem(id);
        if (!item) return cors(json(404, { error: "item not found" }));
        const badge = getRiskBadge(item.risk);
        return cors(json(200, { item, riskBadge: badge }));
      }

      if (url.pathname === "/admin/gallery/npm-search" && req.method === "GET") {
        const query = url.searchParams.get("q") ?? "";
        if (!query) return cors(json(400, { error: "query required" }));
        const results = await searchNpm(query);
        return cors(json(200, { results }));
      }

      if (url.pathname === "/admin/gallery/install" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { galleryId?: string; pluginId?: string };

        if (body.galleryId) {
          const item = getGalleryItem(body.galleryId);
          if (!item) return cors(json(404, { error: "gallery item not found" }));

          if (item.installAction === "plugin") {
            const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, item.installTarget, true);
            await controllerAction("restart", "opencode-core", `gallery install: ${item.name}`);
            setupManager.addExtension(item.id);
            return cors(json(200, { ok: true, installed: item.id, type: "plugin", result }));
          }

          if (item.installAction === "skill-file") {
            setupManager.addExtension(item.id);
            return cors(json(200, { ok: true, installed: item.id, type: "skill", note: "Skill files ship with OpenPalm. Marked as enabled." }));
          }

          if (item.installAction === "compose-service") {
            await controllerAction("up", item.installTarget, `gallery install: ${item.name}`);
            setupManager.addExtension(item.id);
            setupManager.addChannel(item.installTarget);
            return cors(json(200, { ok: true, installed: item.id, type: "container", service: item.installTarget }));
          }

          return cors(json(400, { error: "unknown install action" }));
        }

        if (body.pluginId) {
          if (!validatePluginIdentifier(body.pluginId)) return cors(json(400, { error: "invalid plugin id" }));
          const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, body.pluginId, true);
          await controllerAction("restart", "opencode-core", `npm plugin install: ${body.pluginId}`);
          return cors(json(200, { ok: true, pluginId: body.pluginId, result }));
        }

        return cors(json(400, { error: "galleryId or pluginId required" }));
      }

      if (url.pathname === "/admin/gallery/uninstall" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { galleryId?: string; pluginId?: string };

        if (body.galleryId) {
          const item = getGalleryItem(body.galleryId);
          if (!item) return cors(json(404, { error: "gallery item not found" }));
          if (item.installAction === "plugin") {
            const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, item.installTarget, false);
            await controllerAction("restart", "opencode-core", `gallery uninstall: ${item.name}`);
            return cors(json(200, { ok: true, uninstalled: item.id, type: "plugin", result }));
          }
          if (item.installAction === "compose-service") {
            await controllerAction("down", item.installTarget, `gallery uninstall: ${item.name}`);
            return cors(json(200, { ok: true, uninstalled: item.id, type: "container", service: item.installTarget }));
          }
          return cors(json(200, { ok: true, uninstalled: item.id, type: item.installAction }));
        }

        if (body.pluginId) {
          if (!validatePluginIdentifier(body.pluginId)) return cors(json(400, { error: "invalid plugin id" }));
          const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, body.pluginId, false);
          await controllerAction("restart", "opencode-core", `plugin uninstall: ${body.pluginId}`);
          return cors(json(200, { ok: true, action: "disabled", result }));
        }

        return cors(json(400, { error: "galleryId or pluginId required" }));
      }

      // ── Installed status ──────────────────────────────────────────
      if (url.pathname === "/admin/installed" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const state = setupManager.getState();
        const configRaw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
        const config = parseJsonc(configRaw) as { plugin?: string[] };
        return cors(json(200, {
          plugins: config.plugin ?? [],
          setupState: state
        }));
      }

      // ── Container management ──────────────────────────────────────
      if (url.pathname === "/admin/containers/list" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        if (!CONTROLLER_URL) return cors(json(503, { error: "controller not configured" }));
        const resp = await fetch(`${CONTROLLER_URL}/containers`, {
          headers: { "x-controller-token": CONTROLLER_TOKEN }
        });
        return cors(new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } }));
      }

      if (url.pathname === "/admin/containers/up" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        await controllerAction("up", body.service, "admin-app action");
        return cors(json(200, { ok: true, action: "up", service: body.service }));
      }

      if (url.pathname === "/admin/containers/down" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        await controllerAction("down", body.service, "admin-app action");
        return cors(json(200, { ok: true, action: "down", service: body.service }));
      }

      if (url.pathname === "/admin/containers/restart" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        await controllerAction("restart", body.service, "admin-app action");
        return cors(json(200, { ok: true, action: "restart", service: body.service }));
      }

      if (url.pathname === "/admin/channels" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        return cors(json(200, {
          channels: CHANNEL_SERVICES.map((service) => ({
            service,
            access: service === "channel-chat" ? detectChannelAccess("chat") : service === "channel-voice" ? detectChannelAccess("voice") : service === "channel-discord" ? detectChannelAccess("discord") : detectChannelAccess("telegram"),
            config: readChannelConfig(service)
          }))
        }));
      }

      if (url.pathname === "/admin/channels/access" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { channel: "chat" | "voice" | "discord" | "telegram"; access: "lan" | "public" };
        if (!["chat", "voice", "discord", "telegram"].includes(body.channel)) return cors(json(400, { error: "invalid channel" }));
        if (!["lan", "public"].includes(body.access)) return cors(json(400, { error: "invalid access" }));
        setChannelAccess(body.channel, body.access);
        await controllerAction("restart", "caddy", `channel ${body.channel} access ${body.access}`);
        return cors(json(200, { ok: true, channel: body.channel, access: body.access }));
      }

      if (url.pathname === "/admin/channels/config" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const service = url.searchParams.get("service") ?? "";
        if (!CHANNEL_SERVICES.includes(service as (typeof CHANNEL_SERVICES)[number])) return cors(json(400, { error: "invalid service" }));
        return cors(json(200, { service, config: readChannelConfig(service) }));
      }

      if (url.pathname === "/admin/channels/config" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string; config: Record<string, string>; restart?: boolean };
        if (!CHANNEL_SERVICES.includes(body.service as (typeof CHANNEL_SERVICES)[number])) return cors(json(400, { error: "invalid service" }));
        writeChannelConfig(body.service, body.config ?? {});
        if (body.restart ?? true) await controllerAction("restart", body.service, "channel config update");
        return cors(json(200, { ok: true, service: body.service }));
      }

      // ── Cron jobs ──────────────────────────────────────────────────
      if (url.pathname === "/admin/crons" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        return cors(json(200, { jobs: cronStore.list() }));
      }

      if (url.pathname === "/admin/crons" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { name?: string; schedule?: string; prompt?: string };
        if (!body.name || !body.schedule || !body.prompt) {
          return cors(json(400, { error: "name, schedule, and prompt are required" }));
        }
        const cronError = validateCron(body.schedule);
        if (cronError) return cors(json(400, { error: `invalid cron expression: ${cronError}` }));
        const job = {
          id: randomUUID(),
          name: body.name,
          schedule: body.schedule,
          prompt: body.prompt,
          enabled: true,
          createdAt: new Date().toISOString(),
        };
        cronStore.add(job);
        cronStore.writeCrontab();
        await controllerAction("restart", "opencode-core", `cron job created: ${job.name}`);
        return cors(json(201, { ok: true, job }));
      }

      if (url.pathname === "/admin/crons/update" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string; name?: string; schedule?: string; prompt?: string; enabled?: boolean };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        if (body.schedule) {
          const cronError = validateCron(body.schedule);
          if (cronError) return cors(json(400, { error: `invalid cron expression: ${cronError}` }));
        }
        const { id, ...fields } = body;
        const updated = cronStore.update(id, fields);
        if (!updated) return cors(json(404, { error: "cron job not found" }));
        cronStore.writeCrontab();
        await controllerAction("restart", "opencode-core", `cron job updated: ${updated.name}`);
        return cors(json(200, { ok: true, job: updated }));
      }

      if (url.pathname === "/admin/crons/delete" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        const removed = cronStore.remove(body.id);
        if (!removed) return cors(json(404, { error: "cron job not found" }));
        cronStore.writeCrontab();
        await controllerAction("restart", "opencode-core", "cron job deleted");
        return cors(json(200, { ok: true, deleted: body.id }));
      }

      if (url.pathname === "/admin/crons/trigger" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        const job = cronStore.get(body.id);
        if (!job) return cors(json(404, { error: "cron job not found" }));
        // Fire directly against opencode-core without waiting for cron
        fetch(`${OPENCODE_CORE_URL}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: job.prompt,
            session_id: `cron-${job.id}`,
            user_id: "cron-scheduler",
            metadata: { source: "cron", cronJobId: job.id, cronJobName: job.name },
          }),
          signal: AbortSignal.timeout(120_000),
        }).catch(() => {});
        return cors(json(200, { ok: true, triggered: job.id }));
      }

      // ── Config editor ─────────────────────────────────────────────
      if (url.pathname === "/admin/config" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        return cors(new Response(readFileSync(OPENCODE_CONFIG_PATH, "utf8"), { headers: { "content-type": "text/plain" } }));
      }

      if (url.pathname === "/admin/config" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { config: string; restart?: boolean };
        const parsed = parseJsonc(body.config);
        if (typeof parsed !== "object") return cors(json(400, { error: "invalid jsonc" }));
        const permissions = (parsed as Record<string, unknown>).permission as Record<string, string> | undefined;
        if (permissions && Object.values(permissions).some((v) => v === "allow")) return cors(json(400, { error: "policy lint failed: permission widening blocked" }));
        const backup = snapshotFile(OPENCODE_CONFIG_PATH);
        writeFileSync(OPENCODE_CONFIG_PATH, body.config, "utf8");
        if (body.restart ?? true) await controllerAction("restart", "opencode-core", "config update");
        return cors(json(200, { ok: true, backup }));
      }

      // ── Static UI ─────────────────────────────────────────────────
      if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
        return new Response(Bun.file("/app/admin-ui/index.html"), { headers: { "content-type": "text/html" } });
      }

      return cors(json(404, { error: "not_found" }));
    } catch (error) {
      return cors(json(500, { error: "internal_error", requestId }));
    }
  }
});

console.log(JSON.stringify({ kind: "startup", service: "admin-app", port: server.port }));
