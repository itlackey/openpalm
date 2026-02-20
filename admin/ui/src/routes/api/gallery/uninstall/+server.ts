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
    const item = getGalleryItem(body.galleryId) ?? await getPublicRegistryItem(body.galleryId);
    if (!item) return json({ error: "gallery item not found" }, { status: 404 });

    const setupManager = getSetupManager();

    if (item.installAction === "plugin") {
      const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, item.installTarget, false);
      await controllerAction("restart", "opencode-core", `gallery uninstall: ${item.name}`);
      setupManager.removeExtension(item.id);
      return json({ ok: true, uninstalled: item.id, type: "plugin", result });
    }

    if (item.installAction === "compose-service") {
      await controllerAction("down", item.installTarget, `gallery uninstall: ${item.name}`);
      setupManager.removeExtension(item.id);
      if (CHANNEL_SERVICE_SET.has(item.installTarget)) {
        setupManager.removeChannel(item.installTarget);
      }
      return json({ ok: true, uninstalled: item.id, type: "container", service: item.installTarget });
    }

    setupManager.removeExtension(item.id);
    return json({ ok: true, uninstalled: item.id, type: item.installAction });
  }

  if (body.pluginId) {
    if (!validatePluginIdentifier(body.pluginId)) return json({ error: "invalid plugin id" }, { status: 400 });
    const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, body.pluginId, false);
    await controllerAction("restart", "opencode-core", `plugin uninstall: ${body.pluginId}`);
    return json({ ok: true, action: "disabled", result });
  }

  return json({ error: "galleryId or pluginId required" }, { status: 400 });
};
