import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { a as getSetupManager, g as getStackManager, b as allChannelServiceNames } from "../../../../chunks/init.js";
import { a as updateRuntimeEnv } from "../../../../chunks/env-helpers.js";
import { i as isLocalRequest } from "../../../../chunks/auth.js";
async function normalizeSelectedChannels(value) {
  if (!Array.isArray(value)) return [];
  const validServices = new Set(await allChannelServiceNames());
  const selected = [];
  for (const service of value) {
    if (typeof service !== "string") continue;
    if (!validServices.has(service)) continue;
    if (selected.includes(service)) continue;
    selected.push(service);
  }
  return selected;
}
const POST = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const stackManager = await getStackManager();
  const body = await request.json();
  const current = setupManager.getState();
  if (current.completed && !locals.authenticated) return unauthorizedJson();
  if (!current.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  const channels = await normalizeSelectedChannels(body.channels);
  await updateRuntimeEnv({
    OPENPALM_ENABLED_CHANNELS: channels.length ? channels.join(",") : void 0
  });
  if (body.channelConfigs && typeof body.channelConfigs === "object") {
    for (const [service, values] of Object.entries(body.channelConfigs)) {
      const channelName = service.replace("channel-", "");
      if (stackManager.listChannelNames().includes(channelName) && values && typeof values === "object") {
        stackManager.setChannelConfig(channelName, values);
      }
    }
  }
  const spec = stackManager.getSpec();
  for (const channelName of stackManager.listChannelNames()) {
    const service = `channel-${channelName}`;
    spec.channels[channelName].enabled = channels.includes(service);
  }
  stackManager.setSpec(spec);
  const state = setupManager.setEnabledChannels(channels);
  return json(200, { ok: true, state });
};
export {
  POST
};
