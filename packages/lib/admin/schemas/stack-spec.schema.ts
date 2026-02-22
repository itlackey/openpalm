/**
 * JSON Schema (draft-07) for StackSpec validation.
 * Mirrors the rules in parseStackSpec() for test-time schema validation with ajv.
 */

const channelConfigSchema = {
  type: "object",
  additionalProperties: { type: "string" },
};

const channelSchema = {
  type: "object",
  required: ["enabled", "exposure", "config"],
  properties: {
    enabled: { type: "boolean" },
    exposure: { type: "string", enum: ["host", "lan", "public"] },
    name: { type: "string" },
    description: { type: "string" },
    image: { type: "string", pattern: "^[a-zA-Z0-9]+([._\\/:@-][a-zA-Z0-9]+)*$" },
    containerPort: { type: "integer", minimum: 1, maximum: 65535 },
    hostPort: { type: "integer", minimum: 1, maximum: 65535 },
    domains: {
      type: "array",
      items: {
        type: "string",
        pattern: "^(\\*\\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,}$",
        maxLength: 253,
      },
    },
    pathPrefixes: {
      type: "array",
      items: {
        type: "string",
        pattern: "^/[a-zA-Z0-9/_-]*$",
      },
    },
    volumes: {
      type: "array",
      items: { type: "string" },
    },
    config: channelConfigSchema,
  },
  additionalProperties: false,
};

const serviceSchema = {
  type: "object",
  required: ["enabled", "image", "containerPort", "config"],
  properties: {
    enabled: { type: "boolean" },
    name: { type: "string" },
    description: { type: "string" },
    image: { type: "string", pattern: "^[a-zA-Z0-9]+([._\\/:@-][a-zA-Z0-9]+)*$" },
    containerPort: { type: "integer", minimum: 1, maximum: 65535 },
    volumes: {
      type: "array",
      items: { type: "string" },
    },
    dependsOn: {
      type: "array",
      items: { type: "string" },
    },
    config: channelConfigSchema,
  },
  additionalProperties: false,
};

const automationSchema = {
  type: "object",
  required: ["id", "name", "schedule", "script", "enabled"],
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    schedule: { type: "string", minLength: 1 },
    script: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
    core: { type: "boolean" },
  },
  additionalProperties: false,
};

export const stackSpecSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "StackSpec",
  type: "object",
  required: ["version", "accessScope", "channels"],
  properties: {
    version: { type: "integer", enum: [1, 2, 3] },
    accessScope: { type: "string", enum: ["host", "lan", "public"] },
    caddy: {
      type: "object",
      properties: {
        email: {
          type: "string",
          pattern: "^[^\\s{}\"#]+@[^\\s{}\"#]+\\.[^\\s{}\"#]+$",
        },
      },
      additionalProperties: false,
    },
    channels: {
      type: "object",
      patternProperties: {
        "^[a-z][a-z0-9-]{0,62}$": channelSchema,
      },
      additionalProperties: false,
      required: ["chat", "discord", "voice", "telegram"],
    },
    services: {
      type: "object",
      patternProperties: {
        "^[a-z][a-z0-9-]{0,62}$": serviceSchema,
      },
      additionalProperties: false,
    },
    automations: {
      type: "array",
      items: automationSchema,
    },
  },
  additionalProperties: false,
} as const;
