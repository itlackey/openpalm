/**
 * Test preload: the upstream assistant credential the guardian always needs.
 *
 * `withAssistantUpstreamAuth` attaches Basic auth to every assistant call
 * unconditionally — the assistant requires a password in every configuration —
 * and resolves it from `OPENCODE_SERVER_PASSWORD_FILE`. In the shipped stack
 * that is a compose secret; here it is a temp file, so suites exercise the
 * real always-attached path instead of failing on a missing mount.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!Bun.env.OPENCODE_SERVER_PASSWORD_FILE) {
  const dir = mkdtempSync(join(tmpdir(), "guardian-test-secret-"));
  const file = join(dir, "opencode_server_password");
  writeFileSync(file, "test-upstream-password\n", { mode: 0o600 });
  Bun.env.OPENCODE_SERVER_PASSWORD_FILE = file;
  process.env.OPENCODE_SERVER_PASSWORD_FILE = file;
}
