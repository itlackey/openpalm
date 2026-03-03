/**
 * OpenPalm A2A Agent Card definition.
 *
 * Describes the OpenPalm assistant as an A2A-discoverable agent.
 * The Agent Card is served at /.well-known/agent.json for discovery
 * and also used by the SDK's DefaultRequestHandler.
 */

import type { AgentCard } from "@a2a-js/sdk";

export function buildAgentCard(): AgentCard {
  const bearerToken = Bun.env.A2A_BEARER_TOKEN ?? "";
  return {
    name: "OpenPalm Assistant",
    description:
      "Local-first AI assistant powered by OpenCode with memory, stack management, and coding capabilities",
    url: Bun.env.A2A_PUBLIC_URL || "/",
    version: "0.1.0",
    protocolVersion: "0.2.1",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    ...(bearerToken
      ? {
          securitySchemes: {
            bearer: {
              type: "http",
              scheme: "bearer",
            },
          },
          security: [{ bearer: [] }],
        }
      : {}),
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "general",
        name: "General Assistant",
        description:
          "General-purpose AI assistant with memory, stack management, and coding capabilities",
      },
    ],
  };
}
