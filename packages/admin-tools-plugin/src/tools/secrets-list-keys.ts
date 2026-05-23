/**
 * secrets.list-keys — list the *names* of secrets in stack.env / user vault.
 *
 * SECURITY: This tool NEVER returns values. It returns only the set of keys
 * present in the env files the operator can manage. To set or get a value,
 * the operator uses the admin UI (cookie-gated) — never the agent.
 */
import { tool } from "@opencode-ai/plugin";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function parseEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (key) keys.push(key);
  }
  return keys;
}

function opHome(): string {
  return process.env.OP_HOME ?? join(process.env.HOME ?? "", ".openpalm");
}

export default tool({
  description:
    "List the NAMES of secrets in the OpenPalm env files (stack.env, " +
    "guardian.env, user vault). Never returns values. Use the admin UI to " +
    "view or change a value.",
  args: {
    file: tool.schema
      .enum(["stack", "guardian", "user", "all"])
      .optional()
      .default("all")
      .describe("Which env file to inspect. Defaults to all."),
  },
  async execute(args) {
    const home = opHome();
    const files: Record<string, string> = {
      stack: join(home, "config", "stack", "stack.env"),
      guardian: join(home, "config", "stack", "guardian.env"),
      user: join(home, "stash", "vaults", "user.env"),
    };
    const targets = args.file === "all" ? Object.keys(files) : [args.file];
    const result: Record<string, { exists: boolean; keys: string[] }> = {};
    for (const t of targets) {
      const path = files[t];
      if (!path || !existsSync(path)) {
        result[t] = { exists: false, keys: [] };
        continue;
      }
      try {
        const content = readFileSync(path, "utf-8");
        result[t] = { exists: true, keys: parseEnvKeys(content) };
      } catch {
        result[t] = { exists: false, keys: [] };
      }
    }
    return JSON.stringify(result, null, 2);
  },
});
