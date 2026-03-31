import { tool } from "@opencode-ai/plugin";
import { readFileSync, existsSync } from "fs";

const VAULT_PATH = "/etc/vault/user.env";

export default tool({
  description:
    "Load user vault secrets from /etc/vault/user.env into the running process. " +
    "Returns only the variable names that were loaded — never the values. " +
    "This is the primary way to load API keys, owner info, and other user-configured secrets. " +
    "Use load_env instead only for ad-hoc .env files under /work.",
  args: {
    override: tool.schema
      .boolean()
      .optional()
      .default(false)
      .describe("Replace vars that already exist in the environment"),
    prefix: tool.schema
      .string()
      .optional()
      .describe("Only load vars whose name starts with this prefix"),
  },
  async execute(args) {
    if (!existsSync(VAULT_PATH)) {
      return JSON.stringify({
        status: "error",
        message: `Vault file not found: ${VAULT_PATH}`,
      });
    }

    const content = readFileSync(VAULT_PATH, "utf-8");
    const loaded: string[] = [];
    const skipped: string[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;

      let key = trimmed.slice(0, eqIdx).trim();
      if (key.startsWith("export ")) key = key.slice(7).trim();
      if (args.prefix && !key.startsWith(args.prefix)) continue;

      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!value) continue;

      if (process.env[key] && !args.override) {
        skipped.push(key);
        continue;
      }

      process.env[key] = value;
      loaded.push(key);
    }

    return JSON.stringify({
      status: "ok",
      source: VAULT_PATH,
      loaded,
      skipped,
      message:
        `Loaded ${loaded.length} variable(s): ${loaded.join(", ") || "(none)"}` +
        (skipped.length
          ? `. Skipped ${skipped.length} existing: ${skipped.join(", ")}`
          : ""),
    });
  },
});
