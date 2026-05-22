import { tool } from "@opencode-ai/plugin";
import { readFile, access } from "fs/promises";

/**
 * `vault:user` is the akm-cli ref for the user-managed env vault. Phase 2
 * of issue #388 (closed by #406) retired the legacy
 * `${OP_HOME}/vault/user → /etc/vault` compose mount; the assistant
 * entrypoint now sources the akm vault file directly at container start,
 * so most callers never need this tool. It remains useful for re-loading
 * after the operator updates a key via the admin UI, and for `prefix`-
 * scoped reads.
 */
const AKM_USER_VAULT_REF = "vault:user";

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
 * Resolve the akm `vault:user` file path. The legacy `/etc/vault/user.env`
 * fallback was retired in akm-vault store — there is no other location to
 * try. If akm is missing, the vault is unprovisioned, or the path it
 * returns no longer exists, this returns `null` and the tool reports an
 * actionable error to the caller.
 */
async function resolveVaultPath(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["akm", "vault", "path", AKM_USER_VAULT_REF], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const path = stdout.trim();
    if (!path) return null;
    try {
      await access(path);
      return path;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export default tool({
  description:
    "Load user vault secrets into the running process. Returns only the " +
    "variable names that were loaded — never the values. Reads from the " +
    "shared akm vault `vault:user` (resolved via `akm vault path`). The " +
    "assistant entrypoint already sources this vault at container startup, " +
    "so call this tool only when you need to pick up a key the operator " +
    "added after the assistant started, or to apply a `prefix` filter.",
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
    const vaultPath = await resolveVaultPath();
    if (!vaultPath) {
      return JSON.stringify({
        error: true,
        message:
          "akm vault `vault:user` not available — the assistant entrypoint " +
          "should have sourced it at startup. Check that akm-cli is installed " +
          "and that the operator has populated the vault via the admin UI.",
      });
    }

    let content: string;
    try {
      content = await readFile(vaultPath, "utf-8");
    } catch (err: unknown) {
      return JSON.stringify({
        error: true,
        message: "Failed to read akm vault file (source=akm:vault:user)",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const { loaded, skipped } = parseEnvContent(content, {
      prefix: args.prefix,
      override: args.override,
    });

    return JSON.stringify({
      source: "akm:vault:user",
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
