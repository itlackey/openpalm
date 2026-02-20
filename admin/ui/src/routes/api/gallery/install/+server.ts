import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN, OPENCODE_CONFIG_PATH, CHANNEL_SERVICE_SET } from '$lib/server/env';
import { getGalleryItem, getPublicRegistryItem } from '$lib/server/gallery';
import { validatePluginIdentifier, updatePluginListAtomically } from '$lib/server/extensions';
import { controllerAction } from '$lib/server/helpers';
import { getSetupManager } from '$lib/server/stores';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }

  const body = await request.json() as { galleryId?: string; pluginId?: string };

  if (body.galleryId) {
    // Look up in curated gallery first, then fall back to community registry
    const isCurated = !!getGalleryItem(body.galleryId);
    const item = getGalleryItem(body.galleryId) ?? await getPublicRegistryItem(body.galleryId);
    if (!item) return json({ error: "gallery item not found" }, { status: 404 });

    // Validate installTarget from community registry items to prevent path traversal
    if (!isCurated && item.installAction === "plugin") {
      if (!validatePluginIdentifier(item.installTarget)) {
        return json({ error: "community registry item has invalid installTarget" }, { status: 400 });
      }
    }

    const setupManager = getSetupManager();

    if (item.installAction === "plugin") {
      const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, item.installTarget, true);
      await controllerAction("restart", "opencode-core", `gallery install: ${item.name}`);
      setupManager.addExtension(item.id);
      return json({ ok: true, installed: item.id, type: "plugin", result });
    }

    if (item.installAction === "skill-file" || item.installAction === "command-file" || item.installAction === "agent-file" || item.installAction === "tool-file") {
      setupManager.addExtension(item.id);
      return json({ ok: true, installed: item.id, type: item.installAction, note: "Built-in extension. Marked as enabled." });
    }

    if (item.installAction === "compose-service") {
      await controllerAction("up", item.installTarget, `gallery install: ${item.name}`);
      setupManager.addExtension(item.id);
      if (CHANNEL_SERVICE_SET.has(item.installTarget)) {
        setupManager.addChannel(item.installTarget);
      }
      return json({ ok: true, installed: item.id, type: "container", service: item.installTarget });
    }

    return json({ error: "unknown install action" }, { status: 400 });
  }

  if (body.pluginId) {
    if (!validatePluginIdentifier(body.pluginId)) return json({ error: "invalid plugin id" }, { status: 400 });
    const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, body.pluginId, true);
    await controllerAction("restart", "opencode-core", `npm plugin install: ${body.pluginId}`);
    getSetupManager().addExtension(body.pluginId);
    return json({ ok: true, pluginId: body.pluginId, result });
  }

  return json({ error: "galleryId or pluginId required" }, { status: 400 });
};
