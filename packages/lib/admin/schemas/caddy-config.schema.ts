/**
 * JSON Schema (draft-07) for the Caddy JSON API config subset we generate.
 * Used for test-time structural validation with ajv.
 */

const matcherSchema = {
  type: "object",
  properties: {
    host: { type: "array", items: { type: "string" } },
    path: { type: "array", items: { type: "string" } },
    remote_ip: {
      type: "object",
      properties: {
        ranges: { type: "array", items: { type: "string" } },
      },
    },
    not: {
      type: "array",
      items: {
        type: "object",
        properties: {
          remote_ip: {
            type: "object",
            properties: {
              ranges: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
  additionalProperties: true,
};

const handlerSchema = {
  type: "object",
  required: ["handler"],
  properties: {
    handler: {
      type: "string",
      enum: ["reverse_proxy", "subroute", "rewrite", "static_response"],
    },
  },
  additionalProperties: true,
};

const routeSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    match: { type: "array", items: matcherSchema },
    handle: { type: "array", items: handlerSchema },
    terminal: { type: "boolean" },
  },
  required: ["handle"],
  additionalProperties: false,
};

const serverSchema = {
  type: "object",
  required: ["listen", "routes"],
  properties: {
    listen: { type: "array", items: { type: "string" } },
    routes: { type: "array", items: routeSchema },
  },
  additionalProperties: true,
};

export const caddyConfigSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "CaddyJsonConfig",
  type: "object",
  required: ["admin", "apps"],
  properties: {
    admin: {
      type: "object",
      required: ["disabled"],
      properties: {
        disabled: { type: "boolean", const: true },
      },
      additionalProperties: true,
    },
    apps: {
      type: "object",
      required: ["http"],
      properties: {
        http: {
          type: "object",
          required: ["servers"],
          properties: {
            servers: {
              type: "object",
              additionalProperties: serverSchema,
            },
          },
          additionalProperties: true,
        },
        tls: { type: "object" },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} as const;
