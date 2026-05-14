import { tool } from "@opencode-ai/plugin";
import { readFile, access } from "fs/promises";
import { existsSync } from "fs";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";

const execFile = promisify(execFileCb);

/**
 * Legacy compose-mounted path. Phase 1 of #388 keeps this as the
 * fallback while the akm secret store mirror catches up; Phase 2 will
 * retire the bind mount and route entirely through akm.
 */
const FALLBACK_VAULT_PATH = "/etc/vault/user.env";
const AKM_USER_VAULT_REF = "vault:user";

type VaultSource = "akm" | "fallback";

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

/**
 * Resolve the user vault file path. Phase 1 of #388: prefer the
 * shared akm store (`vault:user`) so editing through the admin UI
 * immediately reflects on the next call. If the akm CLI is missing
 * or the vault has not been provisioned yet, fall back to the
 * Compose-mounted .env file.
 *
 * We `existsSync`-guard the akm-resolved path so a stale ref (e.g. the
 * vault file was deleted out from under akm) cleanly falls through to
 * the bind-mount fallback instead of returning a non-existent path.
 */
async function resolveVaultPath(): Promise<{ path: string; source: VaultSource }> {
  try {
    const { stdout } = await execFile("akm", ["vault", "path", AKM_USER_VAULT_REF]);
    const path = stdout.trim();
    if (path && existsSync(path)) return { path, source: "akm" };
  } catch {
    // akm not on PATH or vault missing — fall through to legacy file
  }
  return { path: FALLBACK_VAULT_PATH, source: "fallback" };
}

export default tool({
  description:
    "Load user vault secrets into the running process. Returns only the " +
    "variable names that were loaded — never the values. Prefers the " +
    "shared akm vault `vault:user` (resolved via `akm vault path`) and " +
    "falls back to `/etc/vault/user.env` when akm is unavailable. This is " +
    "the primary way to load API keys, owner info, and other user-configured " +
    "secrets. Use load_env only for ad-hoc .env files under /work.",
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
    const { path: vaultPath, source } = await resolveVaultPath();
    // Symbolic label exposed to the LLM. We deliberately do NOT return
    // the absolute filesystem path — the model never needs it, and the
    // stash path can leak operator-side filesystem layout.
    const sourceLabel = source === "akm" ? "akm:vault:user" : "fallback:/etc/vault";

    try {
      await access(vaultPath);
    } catch {
      return JSON.stringify({
        error: true,
        message: `Vault file not found (source=${sourceLabel})`,
      });
    }

    let content: string;
    try {
      content = await readFile(vaultPath, "utf-8");
    } catch (err: unknown) {
      return JSON.stringify({
        error: true,
        message: `Failed to read vault file (source=${sourceLabel})`,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const { loaded, skipped } = parseEnvContent(content, {
      prefix: args.prefix,
      override: args.override,
    });

    return JSON.stringify({
      source: sourceLabel,
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
