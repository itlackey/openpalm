/**
 * Test-only fixture: a minimal OpenCode-shaped OpenAPI `/doc` document that
 * SATISFIES the drift guard (drift.ts assertDocCompatible). The mock assistants
 * in proxy.test.ts / proxy-moderation.test.ts serve this so the boot-time drift
 * check enables the /oc/* proxy; drift.test.ts mutates copies of it to prove the
 * guard trips on a missing allowlisted path or a missing payload shape.
 *
 * It must contain: every OC_ALLOWLIST (method, path) under `paths` (methods as
 * lowercase keys, OpenAPI style), and a `properties` object somewhere that
 * defines `sessionID`, `parts`, and `text` (the two pinned payload shapes).
 *
 * Kept deliberately minimal — only what the coarse drift tripwire reads.
 */

export const OC_DOC_FIXTURE = {
  openapi: "3.0.0",
  info: { title: "opencode", version: "1.15.13" },
  paths: {
    "/session": {
      post: { responses: { "200": { description: "ok" } } },
      get: { responses: { "200": { description: "ok" } } },
    },
    "/session/{id}": {
      get: { responses: { "200": { description: "ok" } } },
      delete: { responses: { "200": { description: "ok" } } },
    },
    "/session/{id}/message": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  parts: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { type: { type: "string" }, text: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/session/{id}/prompt_async": {
      post: { responses: { "204": { description: "no content" } } },
    },
    "/session/{id}/abort": {
      post: { responses: { "200": { description: "ok" } } },
    },
    "/event": {
      get: { responses: { "200": { description: "sse" } } },
    },
    "/permission/{requestID}/reply": {
      post: { responses: { "200": { description: "ok" } } },
    },
  },
  components: {
    schemas: {
      Event: {
        type: "object",
        properties: {
          type: { type: "string" },
          properties: {
            type: "object",
            properties: { sessionID: { type: "string" }, messageID: { type: "string" } },
          },
        },
      },
    },
  },
} as const;
