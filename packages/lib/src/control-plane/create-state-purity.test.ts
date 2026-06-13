/**
 * Purity tests for createState().
 *
 * createState() must be side-effect free: no filesystem writes and no
 * mutation of process.env. This file pins that invariant so any future
 * change that accidentally introduces a write is caught immediately.
 */
import { describe, expect, it, spyOn, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeFs from "node:fs";
import { createState } from "./lifecycle.js";

describe("createState() purity", () => {
  let homeDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  // Each test gets its own temp OP_HOME so filesystem spies can distinguish
  // writes (there should be none) from reads.
  function setup(): void {
    homeDir = mkdtempSync(join(tmpdir(), "op-createstate-purity-"));
    savedEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;
  }

  function teardown(): void {
    if (savedEnv.OP_HOME === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = savedEnv.OP_HOME;
    rmSync(homeDir, { recursive: true, force: true });
  }

  afterEach(teardown);

  it("performs zero filesystem writes", () => {
    setup();

    const writtenPaths: string[] = [];
    const writeFileSpy = spyOn(nodeFs, "writeFileSync").mockImplementation(
      (path, _data, _options?) => {
        writtenPaths.push(String(path));
      },
    );
    const writeFileSyncSpy = spyOn(nodeFs, "writeFile").mockImplementation(
      (path, _data, _cb) => {
        writtenPaths.push(String(path));
        // satisfy the overload: call cb with no error
        if (typeof _cb === "function") (_cb as (err: Error | null) => void)(null);
      },
    );

    try {
      createState();
      expect(writtenPaths).toEqual([]);
    } finally {
      writeFileSpy.mockRestore();
      writeFileSyncSpy.mockRestore();
    }
  });

  it("does not mutate process.env", () => {
    setup();

    const before = { ...process.env };
    createState();
    const after = { ...process.env };

    expect(after).toEqual(before);
  });

  it("returns a ControlPlaneState with expected shape", () => {
    setup();

    const state = createState();

    expect(typeof state.homeDir).toBe("string");
    expect(typeof state.configDir).toBe("string");
    expect(typeof state.stashDir).toBe("string");
    expect(typeof state.dataDir).toBe("string");
    expect(typeof state.stackDir).toBe("string");
    expect(typeof state.services).toBe("object");
    expect(typeof state.artifacts).toBe("object");
  });
});
