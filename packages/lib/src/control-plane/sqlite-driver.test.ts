import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteOpen, requireSqliteOpen } from "./sqlite-driver.js";

describe("sqlite driver seam", () => {
  test("loads a driver under Bun and memoizes it", () => {
    const open = loadSqliteOpen();
    expect(open).not.toBeNull();
    expect(loadSqliteOpen()).toBe(open);
    expect(requireSqliteOpen()).toBe(open as NonNullable<typeof open>);
  });

  test("pragmaRow, exec, and readonly behave as the consumers assume", () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-driver-"));
    try {
      const open = requireSqliteOpen();
      const path = join(dir, "t.db");

      const rw = open(path);
      rw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY);");
      rw.exec("INSERT INTO t DEFAULT VALUES;");
      expect(rw.pragmaRow("page_count")?.page_count).toBeGreaterThan(0);
      // Unknown pragmas are silently ignored by SQLite: no rows, no error.
      expect(rw.pragmaRow("no_such_pragma_exists")).toBeNull();
      rw.close();

      const ro = open(path, { readonly: true });
      expect(ro.pragmaRow("page_count")?.page_count).toBeGreaterThan(0);
      expect(() => ro.exec("INSERT INTO t DEFAULT VALUES;")).toThrow();
      ro.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
