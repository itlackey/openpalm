/**
 * Locks the OP_HOME layout single-source-of-truth (home.ts). Every well-known
 * path is defined ONCE here; this test asserts the four-tree shape so a change is
 * caught and reviewed (and so a future `config/stack`→`system/` move is a one-line
 * edit in home.ts with this test as the guard).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSystemDir,
  resolveStateDir,
  composeFilePath,
  stackEnvFile,
  hostIdentityFile,
  userEnvFile,
  secretsDir,
  stateSecretsDir,
  stateEnvDir,
  authJsonFile,
  ensureHomeDirs,
  remoteServeConfigDir,
  remoteTunnelStateDir,
} from "./home.js";

const H = "/op/home";

describe("OP_HOME layout (single source of truth)", () => {
  test("well-known files derive from the home root, defined once", () => {
    expect(stackEnvFile(H)).toBe("/op/home/state/stack.env");
    expect(hostIdentityFile(H)).toBe("/op/home/state/host-identity.json");
    expect(stackEnvFile(H)).toBe("/op/home/state/stack.env");
    expect(userEnvFile(H)).toBe("/op/home/knowledge/env/user.env");
    expect(secretsDir(H)).toBe("/op/home/knowledge/secrets");
    expect(authJsonFile(H)).toBe("/op/home/knowledge/secrets/auth.json");
    // The default (non-agent-readable) credential trees. They are children of
    // state/, not an eighth top-level tree — one exposure answer per tree.
    expect(stateSecretsDir(H)).toBe("/op/home/state/secrets");
    expect(stateEnvDir(H)).toBe("/op/home/state/env");
    expect(composeFilePath(H, "core.compose.yml")).toBe("/op/home/system/stack/core.compose.yml");
  });

  test("ensureHomeDirs creates the managed (system/) and state/ trees", () => {
    const prev = process.env.OP_HOME;
    const home = mkdtempSync(join(tmpdir(), "op-home-layout-"));
    try {
      process.env.OP_HOME = home;
      ensureHomeDirs();
      expect(resolveSystemDir()).toBe(join(home, "system"));
      expect(resolveStateDir()).toBe(join(home, "state"));
      expect(existsSync(join(home, "system"))).toBe(true);
      expect(existsSync(join(home, "state"))).toBe(true);
      expect(existsSync(join(home, 'data/assistant/.config/opencode'))).toBe(true);
      expect(existsSync(join(home, 'data/guardian/.config/opencode'))).toBe(true);
      expect(existsSync(join(home, 'data/paperclip/.config/opencode'))).toBe(true);
      expect(existsSync(join(home, 'config/paperclip/opencode'))).toBe(true);
      expect(existsSync(join(home, 'config/paperclip/akm'))).toBe(true);
      expect(existsSync(join(home, 'system/paperclip'))).toBe(true);
      expect(existsSync(join(home, 'cache/guardian-opencode'))).toBe(true);
      expect(existsSync(join(home, 'cache/guardian-opencode/runtime'))).toBe(true);
      expect(existsSync(join(home, 'cache/paperclip-opencode'))).toBe(true);
      expect(existsSync(join(home, 'cache/paperclip-opencode/runtime'))).toBe(true);
      expect(existsSync(join(home, 'system/skills'))).toBe(true);
      expect(existsSync(join(home, 'state/secrets'))).toBe(true);
      // The retired per-service stash overlays the /stash/{env,secrets}
      // overmounts pointed at, and the retired private/ tree.
      expect(existsSync(join(home, 'knowledge/paperclip'))).toBe(false);
      expect(existsSync(join(home, 'private'))).toBe(false);
      expect(existsSync(join(home, 'data/paperclip-akm/cache'))).toBe(true);
      expect(existsSync(join(home, 'data/paperclip-akm/data'))).toBe(true);
      expect(statSync(join(home, 'data/assistant/.local/share/opencode/auth.json')).isFile()).toBe(true);
      expect(statSync(join(home, 'data/guardian/.local/share/opencode/auth.json')).isFile()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the remote addon's GENERATED serve config lives outside the overwritten system/ tree", () => {
    // system/ IS the release skeleton: overwriteSystemTree (core-assets.ts)
    // replaces it wholesale on any update that changes a managed file, by
    // renaming the existing tree aside and moving a staged copy of the
    // skeleton into place. Anything generated per-install that lived there
    // would be deleted by that swap — and for this directory specifically the
    // consequence is not just a lost file: containerboot registers an fsnotify
    // watch on the directory holding TS_SERVE_CONFIG and log.Fatalf's when it
    // cannot, so the tunnel would refuse to start after any update.
    expect(remoteServeConfigDir(H)).toBe("/op/home/state/remote");
    expect(remoteServeConfigDir(H).startsWith(`${H}/system/`)).toBe(false);

    // Same reasoning for the tunnel's persistent node identity: losing it
    // re-registers the node and Tailscale appends "-1" to resolve the name
    // collision, silently changing the operator's public URL.
    expect(remoteTunnelStateDir(H)).toBe("/op/home/data/tunnel");
    expect(remoteTunnelStateDir(H).startsWith(`${H}/system/`)).toBe(false);
  });

  test("ensureHomeDirs pre-creates the serve-config directory containerboot watches", () => {
    const prev = process.env.OP_HOME;
    const home = mkdtempSync(join(tmpdir(), "op-home-remote-"));
    try {
      process.env.OP_HOME = home;
      ensureHomeDirs();
      // Must exist as a DIRECTORY before the tunnel container is created:
      // a bind mount of a non-existent source, or of a plain file, leaves
      // containerboot with nothing to watch.
      expect(statSync(remoteServeConfigDir(home)).isDirectory()).toBe(true);
      expect(statSync(remoteTunnelStateDir(home)).isDirectory()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
