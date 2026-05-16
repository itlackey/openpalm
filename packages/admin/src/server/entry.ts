/**
 * Bun.serve entry point for the admin API server.
 * Route handlers are registered via addRoute in ./routes/.
 * SvelteKit still builds the client-side bundle; this runs alongside it.
 *
 * NOTE (Phase 2): SvelteKit +server.ts files remain in place — this runs alongside them.
 * Phase 3 will remove the adapter-node server and make this the sole entry point.
 */
import { dispatch } from "./router.js";

// Route registrations — each module calls addRoute() on import
import "./routes/admin/addons.js";
import "./routes/admin/addons/[name].js";
import "./routes/admin/artifacts.js";
import "./routes/admin/artifacts/[name].js";
import "./routes/admin/artifacts/manifest.js";
import "./routes/admin/audit.js";
import "./routes/admin/auth/login.js";
import "./routes/admin/auth/logout.js";
import "./routes/admin/auth/session.js";
import "./routes/admin/automations.js";
import "./routes/admin/automations/[name]/log.js";
import "./routes/admin/automations/[name]/run.js";
import "./routes/admin/automations/catalog.js";
import "./routes/admin/automations/catalog/install.js";
import "./routes/admin/automations/catalog/refresh.js";
import "./routes/admin/automations/catalog/uninstall.js";
import "./routes/admin/capabilities.js";
import "./routes/admin/capabilities/assignments.js";
import "./routes/admin/capabilities/export/opencode.js";
import "./routes/admin/capabilities/status.js";
import "./routes/admin/capabilities/test.js";
import "./routes/admin/config/validate.js";
import "./routes/admin/containers/down.js";
import "./routes/admin/containers/events.js";
import "./routes/admin/containers/list.js";
import "./routes/admin/containers/pull.js";
import "./routes/admin/containers/restart.js";
import "./routes/admin/containers/stats.js";
import "./routes/admin/containers/up.js";
import "./routes/admin/install.js";
import "./routes/admin/installed.js";
import "./routes/admin/logs.js";
import "./routes/admin/network/check.js";
import "./routes/admin/opencode/model.js";
import "./routes/admin/opencode/providers.js";
import "./routes/admin/opencode/providers/[id]/auth.js";
import "./routes/admin/opencode/providers/[id]/models.js";
import "./routes/admin/opencode/status.js";
import "./routes/admin/providers.js";
import "./routes/admin/providers/custom.js";
import "./routes/admin/providers/local.js";
import "./routes/admin/providers/model.js";
import "./routes/admin/providers/oauth/[providerId]/callback.js";
import "./routes/admin/providers/oauth/finish.js";
import "./routes/admin/providers/oauth/start.js";
import "./routes/admin/providers/save.js";
import "./routes/admin/providers/toggle.js";
import "./routes/admin/secrets.js";
import "./routes/admin/secrets/generate.js";
import "./routes/admin/secrets/user-vault.js";
import "./routes/admin/uninstall.js";
import "./routes/admin/update.js";
import "./routes/admin/upgrade.js";
import "./routes/guardian/health.js";
import "./routes/health.js";

const port = Number(process.env.PORT ?? 8100);
const staticDir = process.env.STATIC_DIR ?? "/app/build/client";

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    // API routes
    if (
      url.pathname.startsWith("/health") ||
      url.pathname.startsWith("/guardian") ||
      url.pathname.startsWith("/admin/")
    ) {
      return dispatch(req);
    }

    // Static files (SvelteKit build output)
    const filePath = `${staticDir}${url.pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // SPA fallback
    return new Response(Bun.file(`${staticDir}/index.html`));
  },
});

console.log(`Admin server listening on :${port}`);
