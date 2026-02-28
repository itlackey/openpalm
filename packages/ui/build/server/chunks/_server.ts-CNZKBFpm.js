import { j as json } from './json-juD_ypql.js';
import { B as BUILTIN_CHANNELS } from './index-CyXiysyI.js';
import './stack-spec-DIyG4On0.js';
import './config-B06wMz0z.js';
import { CoreSecretRequirements } from './stack-manager-WhDd7eOU.js';
import './index-CoD1IJuy.js';
import 'node:fs';
import 'node:path';
import './shared-server-DaWdgxVh.js';
import 'node:crypto';
import './runtime-env-BS_YlF-D.js';
import './cron-Dh4kQz92.js';

const GET = async () => {
  const channelServiceNames = {};
  for (const [key, def] of Object.entries(BUILTIN_CHANNELS)) {
    channelServiceNames[`channel-${key}`] = {
      label: `${def.name} Channel`,
      description: `${def.name} adapter for OpenPalm`
    };
  }
  return json(200, {
    serviceNames: {
      gateway: {
        label: "Message Router",
        description: "Routes messages between channels and your assistant"
      },
      assistant: { label: "AI Assistant", description: "The core assistant engine" },
      openmemory: {
        label: "Memory",
        description: "Stores conversation history and context"
      },
      "openmemory-ui": {
        label: "Memory Dashboard",
        description: "Visual interface for memory data"
      },
      admin: { label: "Admin Panel", description: "This management interface" },
      ...channelServiceNames,
      caddy: { label: "Web Server", description: "Handles secure connections" }
    },
    builtInChannels: BUILTIN_CHANNELS,
    requiredCoreSecrets: CoreSecretRequirements
  });
};

export { GET };
//# sourceMappingURL=_server.ts-CNZKBFpm.js.map
