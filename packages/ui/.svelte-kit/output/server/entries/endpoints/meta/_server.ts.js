import { j as json } from "../../../chunks/json.js";
import { B as BUILTIN_CHANNELS } from "../../../chunks/index.js";
import "../../../chunks/stack-spec.js";
import "../../../chunks/config.js";
import { CoreSecretRequirements } from "../../../chunks/stack-manager.js";
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
export {
  GET
};
