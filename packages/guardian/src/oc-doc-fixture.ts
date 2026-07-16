/**
 * Test-only fixture: a minimal OpenCode-shaped OpenAPI `/doc` document. The mock
 * assistants in the guardian test suite serve this as the upstream `/doc`
 * response so a proxied GET /oc/doc returns a realistic shape.
 *
 * Kept deliberately minimal — just the allowlisted (method, path) pairs under
 * `paths` and the pinned `sessionID`/`parts`/`text` payload shapes.
 */

export const OC_DOC_FIXTURE = {
  openapi: "3.0.0",
  info: { title: "opencode", version: "1.17.13" },
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
    "/question/{requestID}/reply": {
      post: { responses: { "200": { description: "ok" } } },
    },
    "/question/{requestID}/reject": {
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
