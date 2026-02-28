import { u as unauthorizedJson, j as json } from "../../../chunks/json.js";
import { g as getStackManager } from "../../../chunks/init.js";
import { i as isBuiltInChannel } from "../../../chunks/stack-spec.js";
const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const spec = stackManager.getSpec();
  const channelNames = stackManager.listChannelNames();
  return json(200, {
    channels: channelNames.map((channelName) => ({
      service: `channel-${channelName}`,
      label: channelName.charAt(0).toUpperCase() + channelName.slice(1),
      builtIn: isBuiltInChannel(channelName),
      access: stackManager.getChannelAccess(channelName),
      config: { ...spec.channels[channelName].config },
      channelSpec: spec.channels[channelName]
    }))
  });
};
export {
  GET
};
