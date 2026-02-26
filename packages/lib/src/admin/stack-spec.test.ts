import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { createDefaultStackSpec, ensureStackSpec, parseStackSpec, parseSecretReference, stringifyStackSpec, StackSpecVersion } from "./stack-spec.ts";
import { parseYamlDocument, stringifyYamlDocument } from "../shared/yaml.ts";

describe("stack spec", () => {
  it("creates a default stack spec when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const path = join(dir, "openpalm.yaml");
    const spec = ensureStackSpec(path);
    expect(spec.version).toBe(StackSpecVersion);
    expect(spec.channels.chat.enabled).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("version:");
  });

  it("rejects unknown top-level stack spec fields", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({ ...base, connections: [] })).toThrow("unknown_stack_spec_field_connections");
  });

  it("accepts arbitrary community channel names", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      channels: {
        ...base.channels,
        "Community Slack / v1": {
          enabled: true,
          exposure: "public",
          image: "ghcr.io/community/slack:latest",
          containerPort: 8201,
          rewritePath: "/slack/events",
          sharedSecretEnv: "CHANNEL_COMMUNITY_SLACK_SECRET",
          config: {
            "x.custom": "on",
            CHANNEL_COMMUNITY_SLACK_SECRET: "${COMMUNITY_SECRET}",
          },
        },
      },
    });

    expect(parsed.channels["Community Slack / v1"].config["x.custom"]).toBe("on");
  });

  it("rejects empty channel names", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({ ...base, channels: { ...base.channels, "": { enabled: true, exposure: "lan", config: {} } } })).toThrow("invalid_channel_name_");
  });

  it("parses explicit secret references", () => {
    expect(parseSecretReference("${OPENAI_API_KEY}")).toBe("OPENAI_API_KEY");
    expect(parseSecretReference("OPENAI_API_KEY")).toBeNull();
  });

  it("roundtrips through shared yaml utility", () => {
    const spec = createDefaultStackSpec();
    spec.accessScope = "public";
    const yaml = stringifyYamlDocument(spec);
    const parsed = parseYamlDocument(yaml);
    const out = parseStackSpec(parsed);
    expect(out.accessScope).toBe("public");
  });

  it("writes and reads stack spec from filesystem", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const path = join(dir, "openpalm.yaml");
    const spec = createDefaultStackSpec();
    spec.channels.chat.exposure = "host";
    writeFileSync(path, stringifyStackSpec(spec), "utf8");
    const saved = ensureStackSpec(path);
    expect(saved.channels.chat.exposure).toBe("host");
  });

  it("reads YAML stack spec from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const yamlPath = join(dir, "openpalm.yaml");
    const spec = createDefaultStackSpec();
    writeFileSync(yamlPath, stringifyStackSpec(spec), "utf8");
    const loaded = ensureStackSpec(yamlPath);
    expect(loaded.version).toBe(StackSpecVersion);
    expect(readFileSync(yamlPath, "utf8")).toContain("version:");
  });
});
