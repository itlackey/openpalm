import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readInstallMetadata,
  writeInstallMetadata,
  createInstallMetadata,
  appendMetadataEvent,
  metadataPath,
} from "./install-metadata.ts";
import type { InstallMetadata } from "./types.ts";

describe("install-metadata", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "op-meta-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when metadata file does not exist", () => {
    expect(readInstallMetadata(tmp)).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    const path = metadataPath(tmp);
    require("node:fs").writeFileSync(path, "not json", "utf8");
    expect(readInstallMetadata(tmp)).toBeNull();
  });

  it("returns null for invalid schema version", () => {
    const path = metadataPath(tmp);
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 99 }),
      "utf8",
    );
    expect(readInstallMetadata(tmp)).toBeNull();
  });

  it("creates valid metadata with install event", () => {
    const meta = createInstallMetadata({
      mode: "fresh",
      runtime: "docker",
      port: 80,
      version: "1.0.0",
    });
    expect(meta.schemaVersion).toBe(1);
    expect(meta.mode).toBe("fresh");
    expect(meta.runtime).toBe("docker");
    expect(meta.port).toBe(80);
    expect(meta.version).toBe("1.0.0");
    expect(meta.history).toHaveLength(1);
    expect(meta.history[0].action).toBe("install");
  });

  it("round-trips write and read", () => {
    const meta = createInstallMetadata({
      mode: "fresh",
      runtime: "docker",
      port: 8080,
    });
    writeInstallMetadata(tmp, meta);
    const read = readInstallMetadata(tmp);
    expect(read).not.toBeNull();
    expect(read!.mode).toBe("fresh");
    expect(read!.port).toBe(8080);
    expect(read!.runtime).toBe("docker");
  });

  it("appends events and updates lastUpdatedAt", () => {
    const meta = createInstallMetadata({
      mode: "fresh",
      runtime: "docker",
      port: 80,
    });
    const updated = appendMetadataEvent(meta, {
      action: "setup_complete",
      timestamp: new Date().toISOString(),
    });
    expect(updated.history).toHaveLength(2);
    expect(updated.history[1].action).toBe("setup_complete");
    expect(updated.lastUpdatedAt).toBeDefined();
  });

  it("creates parent directories when writing", () => {
    const nested = join(tmp, "nested", "dir");
    const meta = createInstallMetadata({
      mode: "fresh",
      runtime: "podman",
      port: 80,
    });
    writeInstallMetadata(nested, meta);
    const read = readInstallMetadata(nested);
    expect(read).not.toBeNull();
    expect(read!.runtime).toBe("podman");
  });

  it("overwrites existing metadata on write", () => {
    const meta1 = createInstallMetadata({
      mode: "fresh",
      runtime: "docker",
      port: 80,
    });
    writeInstallMetadata(tmp, meta1);

    const meta2 = createInstallMetadata({
      mode: "reinstall",
      runtime: "orbstack",
      port: 8080,
    });
    writeInstallMetadata(tmp, meta2);

    const read = readInstallMetadata(tmp);
    expect(read!.mode).toBe("reinstall");
    expect(read!.runtime).toBe("orbstack");
    expect(read!.port).toBe(8080);
  });

  it("rejects metadata missing required fields", () => {
    const path = metadataPath(tmp);
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, mode: "fresh" }),
      "utf8",
    );
    expect(readInstallMetadata(tmp)).toBeNull();
  });
});
