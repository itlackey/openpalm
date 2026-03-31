import { tool } from "@opencode-ai/plugin";
import { readFile, access } from "fs/promises";

const VAULT_PATH = "/etc/vault/user.env";

export function parseEnvContent(
  content: string,
  opts: { prefix?: string; override?: boolean },
): { loaded: string[]; skipped: string[] } {
  const loaded: string[] = [];
  const skipped: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    let key = trimmed.slice(0, eqIdx).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (opts.prefix && !key.startsWith(opts.prefix)) continue;

    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!value) continue;

    if (key in process.env && !opts.override) {
      skipped.push(key);
      continue;
    }

    process.env[key] = value;
    loaded.push(key);
  }

  return { loaded, skipped };
}

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
    try {
      await access(VAULT_PATH);
    } catch {
      return JSON.stringify({
        error: true,
        message: `Vault file not found: ${VAULT_PATH}`,
      });
    }

    let content: string;
    try {
      content = await readFile(VAULT_PATH, "utf-8");
    } catch (err: unknown) {
      return JSON.stringify({
        error: true,
        message: `Failed to read vault file: ${VAULT_PATH}`,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const { loaded, skipped } = parseEnvContent(content, {
      prefix: args.prefix,
      override: args.override,
    });

    return JSON.stringify({
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
