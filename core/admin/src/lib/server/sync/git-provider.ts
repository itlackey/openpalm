/**
 * Git sync provider — versioning and remote sync via the git CLI.
 *
 * Follows the same pattern as docker.ts: all commands use execFile with
 * argument arrays to prevent command injection. No user input is ever
 * interpolated into shell strings.
 *
 * Secrets handling: .gitignore always contains secrets.env so credentials
 * are never committed. On restore(), secrets.env is explicitly excluded.
 */
import { execFile } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ConfigSyncProvider,
  SyncResult,
  SnapshotResult,
  HistoryResult,
  SyncSnapshot,
  SyncStatus
} from "./types.js";

/** Files that must never be committed (contain credentials). */
const IGNORED_FILES = ["secrets.env"];

/** Default .gitignore content for CONFIG_HOME. */
const GITIGNORE_CONTENT = [
  "# OpenPalm — auto-managed by config sync",
  "# secrets.env contains API keys and tokens — never commit.",
  "secrets.env",
  ""
].join("\n");

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

/** Execute git with an argument array — no shell interpolation. */
function git(args: string[], cwd: string, timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          code: error?.code ? Number(error.code) : 0
        });
      }
    );
  });
}

/** Check if a directory is a git repository. */
async function isGitRepo(dir: string): Promise<boolean> {
  const result = await git(["rev-parse", "--is-inside-work-tree"], dir);
  return result.ok && result.stdout.trim() === "true";
}

/** Check if there are uncommitted changes (staged or unstaged). */
async function isDirty(dir: string): Promise<boolean> {
  const result = await git(["status", "--porcelain"], dir);
  return result.ok && result.stdout.trim().length > 0;
}

/** Get the configured remote URL, or empty string if none. */
async function getRemoteUrl(dir: string): Promise<string> {
  const result = await git(["remote", "get-url", "origin"], dir);
  return result.ok ? result.stdout.trim() : "";
}

/** Mask a remote URL for display (hide tokens in HTTPS URLs). */
function maskRemote(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "****";
    }
    if (parsed.username && parsed.username !== "git") {
      parsed.username = parsed.username.slice(0, 2) + "****";
    }
    return parsed.toString();
  } catch {
    // SSH or other format — return as-is
    return url;
  }
}

/** Ensure .gitignore exists and contains the required entries. */
function ensureGitignore(configDir: string): void {
  const gitignorePath = `${configDir}/.gitignore`;
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    // Make sure all ignored files are present
    let updated = content;
    for (const file of IGNORED_FILES) {
      if (!content.split("\n").some((line) => line.trim() === file)) {
        updated = updated.trimEnd() + "\n" + file + "\n";
      }
    }
    if (updated !== content) {
      writeFileSync(gitignorePath, updated);
    }
  } else {
    writeFileSync(gitignorePath, GITIGNORE_CONTENT);
  }
}

export const gitProvider: ConfigSyncProvider = {
  name: "git",

  async init(configDir: string): Promise<SyncResult> {
    if (await isGitRepo(configDir)) {
      // Already initialized — just ensure .gitignore is correct
      ensureGitignore(configDir);
      return { ok: true };
    }

    const result = await git(["init"], configDir);
    if (!result.ok) {
      return { ok: false, error: `git init failed: ${result.stderr}` };
    }

    ensureGitignore(configDir);

    // Configure a default committer identity for the repo
    await git(["config", "user.email", "admin@openpalm.local"], configDir);
    await git(["config", "user.name", "OpenPalm Admin"], configDir);

    // Create initial commit
    await git(["add", "-A"], configDir);
    const commitResult = await git(
      ["commit", "-m", "Initial config snapshot", "--allow-empty"],
      configDir
    );
    if (!commitResult.ok && !commitResult.stderr.includes("nothing to commit")) {
      return { ok: false, error: `Initial commit failed: ${commitResult.stderr}` };
    }

    return { ok: true };
  },

  async snapshot(configDir: string, message: string): Promise<SnapshotResult> {
    if (!(await isGitRepo(configDir))) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    ensureGitignore(configDir);

    // Stage all changes
    const addResult = await git(["add", "-A"], configDir);
    if (!addResult.ok) {
      return { ok: false, error: `git add failed: ${addResult.stderr}` };
    }

    // Check if there's anything to commit
    if (!(await isDirty(configDir))) {
      // Nothing to commit — return success with no ID
      return { ok: true };
    }

    const commitResult = await git(["commit", "-m", message], configDir);
    if (!commitResult.ok) {
      if (commitResult.stderr.includes("nothing to commit")) {
        return { ok: true };
      }
      return { ok: false, error: `git commit failed: ${commitResult.stderr}` };
    }

    // Get the SHA of the new commit
    const shaResult = await git(["rev-parse", "HEAD"], configDir);
    const id = shaResult.ok ? shaResult.stdout.trim() : undefined;

    return { ok: true, id };
  },

  async push(configDir: string): Promise<SyncResult> {
    if (!(await isGitRepo(configDir))) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    const remote = await getRemoteUrl(configDir);
    if (!remote) {
      return { ok: false, error: "No remote configured" };
    }

    const result = await git(["push", "-u", "origin", "HEAD"], configDir, 60_000);
    if (!result.ok) {
      return { ok: false, error: `git push failed: ${result.stderr}` };
    }

    return { ok: true };
  },

  async pull(configDir: string): Promise<SyncResult> {
    if (!(await isGitRepo(configDir))) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    const remote = await getRemoteUrl(configDir);
    if (!remote) {
      return { ok: false, error: "No remote configured" };
    }

    // Fetch first
    const fetchResult = await git(["fetch", "origin"], configDir, 60_000);
    if (!fetchResult.ok) {
      return { ok: false, error: `git fetch failed: ${fetchResult.stderr}` };
    }

    // Get current branch
    const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"], configDir);
    const branch = branchResult.ok ? branchResult.stdout.trim() : "main";

    // Check if remote branch exists
    const remoteRef = await git(["rev-parse", "--verify", `origin/${branch}`], configDir);
    if (!remoteRef.ok) {
      // Remote branch doesn't exist yet — nothing to pull
      return { ok: true };
    }

    // Fast-forward only — abort on diverged history
    const mergeResult = await git(["merge", "--ff-only", `origin/${branch}`], configDir);
    if (!mergeResult.ok) {
      return {
        ok: false,
        error: "Remote has diverged — fast-forward not possible. Manual resolution required."
      };
    }

    return { ok: true };
  },

  async history(configDir: string, limit = 20): Promise<HistoryResult> {
    if (!(await isGitRepo(configDir))) {
      return { ok: false, snapshots: [], error: "Not initialized — run init first" };
    }

    // Use a separator-based format for reliable parsing
    const sep = "---OPENPALM-SEP---";
    const format = `%H${sep}%s${sep}%aI`;
    const result = await git(
      ["log", `--format=${format}`, `-${limit}`],
      configDir
    );

    if (!result.ok) {
      if (result.stderr.includes("does not have any commits")) {
        return { ok: true, snapshots: [] };
      }
      return { ok: false, snapshots: [], error: `git log failed: ${result.stderr}` };
    }

    const snapshots: SyncSnapshot[] = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, message, timestamp] = line.split(sep);
        return { id: id ?? "", message: message ?? "", timestamp: timestamp ?? "" };
      })
      .filter((s) => s.id);

    return { ok: true, snapshots };
  },

  async restore(configDir: string, snapshotId: string): Promise<SyncResult> {
    if (!(await isGitRepo(configDir))) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    // Validate the snapshot ID exists
    const verifyResult = await git(["cat-file", "-t", snapshotId], configDir);
    if (!verifyResult.ok || verifyResult.stdout.trim() !== "commit") {
      return { ok: false, error: `Invalid snapshot ID: ${snapshotId}` };
    }

    // Full tree restore: remove files that exist now but not in the target
    // snapshot, then checkout the snapshot's files. Plain `git checkout <id> -- .`
    // is overlay-only and leaves newer files on disk.
    const currentBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], configDir)).stdout.trim() || "HEAD";

    // Find files tracked in HEAD but absent in the target snapshot
    const diffResult = await git(
      ["diff", "--name-only", "--diff-filter=A", snapshotId, currentBranch],
      configDir
    );
    if (diffResult.ok && diffResult.stdout.trim()) {
      for (const file of diffResult.stdout.trim().split("\n").filter(Boolean)) {
        // Never delete secrets.env
        if (file === "secrets.env") continue;
        const fullPath = `${configDir}/${file}`;
        if (existsSync(fullPath)) {
          rmSync(fullPath, { force: true });
          // Clean up empty parent directories up to configDir
          let parent = dirname(fullPath);
          while (parent !== configDir && existsSync(parent)) {
            try {
              // rmSync on a non-empty dir throws — exactly what we want
              rmSync(parent);
              parent = dirname(parent);
            } catch {
              break;
            }
          }
        }
      }
    }

    // Checkout files from the target snapshot
    const checkoutResult = await git(
      ["checkout", snapshotId, "--", "."],
      configDir
    );
    if (!checkoutResult.ok) {
      return { ok: false, error: `Restore failed: ${checkoutResult.stderr}` };
    }

    // Restore secrets.env to current version (don't overwrite live credentials)
    await git(["checkout", currentBranch, "--", "secrets.env"], configDir);

    // Ensure .gitignore is still correct after restore
    ensureGitignore(configDir);

    return { ok: true };
  },

  async status(configDir: string): Promise<SyncStatus> {
    const initialized = await isGitRepo(configDir);
    if (!initialized) {
      return {
        initialized: false,
        provider: "git",
        remote: "",
        lastSync: "",
        dirty: false
      };
    }

    const remote = maskRemote(await getRemoteUrl(configDir));
    const dirty = await isDirty(configDir);

    // Get the timestamp of the last commit as a proxy for lastSync
    const logResult = await git(["log", "-1", "--format=%aI"], configDir);
    const lastSync = logResult.ok ? logResult.stdout.trim() : "";

    return {
      initialized: true,
      provider: "git",
      remote,
      lastSync,
      dirty
    };
  },

  async setRemote(configDir: string, remote: string): Promise<SyncResult> {
    if (!(await isGitRepo(configDir))) {
      return { ok: false, error: "Not initialized — run init first" };
    }

    // Check if origin already exists
    const existingRemote = await getRemoteUrl(configDir);

    let result: GitResult;
    if (existingRemote) {
      result = await git(["remote", "set-url", "origin", remote], configDir);
    } else {
      result = await git(["remote", "add", "origin", remote], configDir);
    }

    if (!result.ok) {
      return { ok: false, error: `Failed to set remote: ${result.stderr}` };
    }

    return { ok: true };
  }
};
