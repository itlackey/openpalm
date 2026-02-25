import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

const ADMIN_BASE = "http://localhost:8100";
const ADMIN_TOKEN = "dev-admin-token";

// Resolve .dev/ relative to the main worktree root (where Docker mounts from),
// not the current working directory — which may be a git worktree.
const repoRoot = resolve(execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim(), "..");
const STATE_FILE_HOST = resolve(repoRoot, ".dev/data/admin/setup-state.json");

const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";

// Backup/restore helpers for the real state file. The backup is stored in a
// mkdtempSync directory so it persists on disk (safer than an in-memory variable
// if the process is killed). The outer describe block calls backupState() in
// beforeAll and restoreState() in afterAll.
let _backupDir: string | null = null;
let _hadFile = false;

function backupState(): void {
  _backupDir = mkdtempSync(join(tmpdir(), "openpalm-contract-setup-"));
  _hadFile = existsSync(STATE_FILE_HOST);
  if (_hadFile) {
    copyFileSync(STATE_FILE_HOST, join(_backupDir, "setup-state.json.bak"));
  }
}

function restoreState(): void {
  const backupDir = _backupDir;
  if (backupDir === null) {
    return;
  }
  const backupFile = join(backupDir, "setup-state.json.bak");
  if (_hadFile && existsSync(backupFile)) {
    mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
    copyFileSync(backupFile, STATE_FILE_HOST);
  } else if (existsSync(STATE_FILE_HOST)) {
    rmSync(STATE_FILE_HOST);
  }
  rmSync(backupDir, { recursive: true, force: true });
  _backupDir = null;
}

describe.skipIf(!stackAvailable)("contract: setup wizard gate", () => {
  beforeAll(() => {
    backupState();
  });

  afterAll(() => {
    restoreState();
  });

  describe("first boot (no state file)", () => {
    beforeAll(() => {
      if (existsSync(STATE_FILE_HOST)) rmSync(STATE_FILE_HOST);
    });

    it("returns 200 without requiring auth", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(resp.status).toBe(200);
    });

    it("returns completed: false", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { completed: boolean };
      expect(body.completed).toBe(false);
    });

    it("returns firstBoot: true", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { firstBoot: boolean };
      expect(body.firstBoot).toBe(true);
    });

    it("includes step status showing no steps completed", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { steps: Record<string, boolean> };
      for (const [_step, done] of Object.entries(body.steps)) {
        expect(done).toBe(false);
      }
    });
  });

  describe("after setup is complete", () => {
    beforeAll(() => {
      mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
      writeFileSync(
        STATE_FILE_HOST,
        JSON.stringify({
          completed: true,
          completedAt: new Date().toISOString(),
          accessScope: "host",
          serviceInstances: { openmemory: "", psql: "", qdrant: "" },
          smallModel: { endpoint: "", modelId: "" },
          profile: { name: "", email: "" },
          steps: {
            welcome: true, profile: true, accessScope: true, serviceInstances: true,
            healthCheck: true, security: true, channels: true, extensions: false,
          },
          enabledChannels: [],
          installedExtensions: [],
        }),
        "utf8"
      );
    });

    it("returns 401 without auth token (wizard cannot appear)", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(resp.status).toBe(401);
    });

    it("returns 200 with valid auth token", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      expect(resp.status).toBe(200);
    });

    it("returns completed: true with valid auth", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { completed: boolean };
      expect(body.completed).toBe(true);
    });

    it("returns firstBoot: false with valid auth", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { firstBoot: boolean };
      expect(body.firstBoot).toBe(false);
    });
  });
});
