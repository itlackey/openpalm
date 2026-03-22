import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

const ALLOWED_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENVIKING_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_API_KEY",
  "MCP_API_KEY",
  "EMBEDDING_API_KEY",
  "OPENAI_BASE_URL",
  "OWNER_NAME",
  "OWNER_EMAIL",
]);

export const get = tool({
  description: "Get current LLM provider connection keys and config values. API key values are masked (all but last 4 characters visible). Use this to see which keys are configured without exposing actual values.",
  async execute() {
    return adminFetch("/admin/connections");
  },
});

export const set = tool({
  description: "Update one or more LLM provider connection keys in vault/user/user.env. Only allowed keys are accepted: OPENAI_API_KEY, OPENVIKING_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, GOOGLE_API_KEY, MCP_API_KEY, EMBEDDING_API_KEY, OPENAI_BASE_URL, OWNER_NAME, OWNER_EMAIL. Never log or echo the actual key values.",
  args: {
    patches: tool.schema.string().describe("JSON object of key-value pairs to update, e.g. '{\"OPENAI_API_KEY\":\"sk-...\",\"OWNER_NAME\":\"Alice\"}'"),
  },
  async execute(args) {
    let body: Record<string, string>;
    try {
      const parsed = JSON.parse(args.patches) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return JSON.stringify({ error: true, message: "patches must be a JSON object" });
      }
      body = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!ALLOWED_KEYS.has(key)) {
          return JSON.stringify({
            error: true,
            message: `Unsupported key '${key}'. Only approved connection keys can be set.`,
          });
        }
        if (typeof value !== "string") {
          return JSON.stringify({
            error: true,
            message: `Invalid value for '${key}'. Expected a string value.`,
          });
        }
        body[key] = value;
      }
    } catch {
      return JSON.stringify({ error: true, message: "Invalid JSON in patches argument" });
    }
    return adminFetch("/admin/connections", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
});

export const status = tool({
  description: "Check whether the system LLM connection is configured (provider and model set). Returns { complete: boolean, missing: string[] }. API keys are optional for all providers.",
  async execute() {
    return adminFetch("/admin/connections/status");
  },
});
