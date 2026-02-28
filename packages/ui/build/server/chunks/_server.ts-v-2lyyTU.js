import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { a as getStackManager } from './init-C6nnJEAN.js';
import { i as isBuiltInChannel } from './stack-spec-DIyG4On0.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import './index-CyXiysyI.js';
import 'node:fs';
import 'node:path';

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

export { GET };
//# sourceMappingURL=_server.ts-v-2lyyTU.js.map
