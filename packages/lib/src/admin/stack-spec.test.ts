import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { createDefaultStackSpec, ensureStackSpec, parseStackSpec, parseSecretReference, writeStackSpec, StackSpecVersion } from "./stack-spec.ts";
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

  it("accepts arbitrary community channel and service names", () => {
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
      services: {
        "jobs worker@nightly": {
          enabled: true,
          image: "ghcr.io/community/jobs:latest",
          containerPort: 9901,
          config: {
            "worker.mode": "nightly",
          },
        },
      },
    });

    expect(parsed.channels["Community Slack / v1"].config["x.custom"]).toBe("on");
    expect(parsed.services["jobs worker@nightly"].config["worker.mode"]).toBe("nightly");
  });

  it("rejects empty channel and service names", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({ ...base, channels: { ...base.channels, "": { enabled: true, exposure: "lan", config: {} } } })).toThrow("invalid_channel_name_");
    expect(() => parseStackSpec({ ...base, services: { "": { enabled: true, image: "x:latest", containerPort: 9999, config: {} } } })).toThrow("invalid_service_name_");
  });

  it("rejects empty config keys but accepts arbitrary non-empty keys", () => {
    const base = createDefaultStackSpec();
    const parsed = parseStackSpec({
      ...base,
      services: {
        svc: {
          enabled: true,
          image: "x:latest",
          containerPort: 9999,
          config: {
            "key.with.symbols": "value",
          },
        },
      },
    });
    expect(parsed.services.svc.config["key.with.symbols"]).toBe("value");

    expect(() => parseStackSpec({
      ...base,
      services: {
        svc: {
          enabled: true,
          image: "x:latest",
          containerPort: 9999,
          config: {
            "": "value",
          },
        },
      },
    })).toThrow("invalid_service_config_key_svc_empty");
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
    writeStackSpec(path, spec);
    const saved = ensureStackSpec(path);
    expect(saved.channels.chat.exposure).toBe("host");
  });

  it("reads YAML stack spec from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-spec-"));
    const yamlPath = join(dir, "openpalm.yaml");
    const spec = createDefaultStackSpec();
    writeStackSpec(yamlPath, spec);
    const loaded = ensureStackSpec(yamlPath);
    expect(loaded.version).toBe(StackSpecVersion);
    expect(readFileSync(yamlPath, "utf8")).toContain("version:");
  });
});
