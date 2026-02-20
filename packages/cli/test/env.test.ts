import { describe, expect, it } from "bun:test";
import { readEnvFile, upsertEnvVar, generateEnvFromTemplate, readEnvVar } from "../src/lib/env.ts";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("env", () => {
  describe("readEnvFile", () => {
    it("parses key=value pairs correctly", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));
      const envPath = join(tempDir, ".env");

      try {
        await writeFile(envPath, "KEY1=value1\nKEY2=value2\n");
        const env = await readEnvFile(envPath);
        expect(env).toEqual({ KEY1: "value1", KEY2: "value2" });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("skips comments and blank lines", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));
      const envPath = join(tempDir, ".env");

      try {
        await writeFile(
          envPath,
          "# This is a comment\nKEY1=value1\n\n# Another comment\nKEY2=value2\n"
        );
        const env = await readEnvFile(envPath);
        expect(env).toEqual({ KEY1: "value1", KEY2: "value2" });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("handles values containing =", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));
      const envPath = join(tempDir, ".env");

      try {
        await writeFile(envPath, "KEY1=value=with=equals\n");
        const env = await readEnvFile(envPath);
        expect(env).toEqual({ KEY1: "value=with=equals" });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("returns empty object for non-existent file", async () => {
      const env = await readEnvFile("/nonexistent/path/.env");
      expect(env).toEqual({});
    });
  });

  describe("upsertEnvVar", () => {
    it("creates file if it doesn't exist", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));
      const envPath = join(tempDir, ".env");

      try {
        await upsertEnvVar(envPath, "KEY1", "value1");
        const content = await readFile(envPath, "utf-8");
        expect(content).toBe("KEY1=value1\n");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("updates existing key", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));
      const envPath = join(tempDir, ".env");

      try {
        await writeFile(envPath, "KEY1=oldvalue\nKEY2=value2\n");
        await upsertEnvVar(envPath, "KEY1", "newvalue");
        const env = await readEnvFile(envPath);
        expect(env).toEqual({ KEY1: "newvalue", KEY2: "value2" });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("appends new key if not found", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));
      const envPath = join(tempDir, ".env");

      try {
        await writeFile(envPath, "KEY1=value1\n");
        await upsertEnvVar(envPath, "KEY2", "value2");
        const env = await readEnvFile(envPath);
        expect(env).toEqual({ KEY1: "value1", KEY2: "value2" });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("generateEnvFromTemplate", () => {
    it("copies template and applies overrides", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));
      const templatePath = join(tempDir, ".env.template");
      const outputPath = join(tempDir, ".env");

      try {
        await writeFile(templatePath, "KEY1=template_value\nKEY2=template_value2\n");
        await generateEnvFromTemplate(templatePath, outputPath, {
          KEY1: "override_value",
          KEY3: "new_value",
        });

        const env = await readEnvFile(outputPath);
        expect(env).toEqual({
          KEY1: "override_value",
          KEY2: "template_value2",
          KEY3: "new_value",
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("readEnvVar", () => {
    it("reads specific environment variables from file", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));
      const envPath = join(tempDir, ".env");

      try {
        await writeFile(envPath, "KEY1=value1\nKEY2=value2\n");

        const value1 = await readEnvVar(envPath, "KEY1");
        expect(value1).toBe("value1");

        const value2 = await readEnvVar(envPath, "KEY2");
        expect(value2).toBe("value2");

        const nonexistent = await readEnvVar(envPath, "NONEXISTENT");
        expect(nonexistent).toBeUndefined();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
