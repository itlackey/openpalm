import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { generateStackArtifacts } from "../stack-generator.ts";
import { createDefaultStackSpec } from "../stack-spec.ts";
import { stackSpecSchema } from "./stack-spec.schema.ts";
import { caddyConfigSchema } from "./caddy-config.schema.ts";
import { substituteComposeVariables } from "./compose-helpers.ts";

describe("ajv schema validation of generated output", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  it("generated Caddy JSON validates against caddy-config schema", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const validate = ajv.compile(caddyConfigSchema);
    const valid = validate(caddyConfig);
    if (!valid) {
      console.error("Caddy JSON schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("generated Caddy JSON with domains validates against schema", () => {
    const spec = createDefaultStackSpec();
    spec.channels["public-api"] = {
      enabled: true,
      exposure: "public",
      image: "api:latest",
      containerPort: 9000,
      domains: ["api.example.com"],
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const validate = ajv.compile(caddyConfigSchema);
    const valid = validate(caddyConfig);
    if (!valid) {
      console.error("Caddy JSON (domains) schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("generated Caddy JSON with TLS email validates against schema", () => {
    const spec = createDefaultStackSpec();
    spec.caddy = { email: "admin@example.com" };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const validate = ajv.compile(caddyConfigSchema);
    const valid = validate(caddyConfig);
    if (!valid) {
      console.error("Caddy JSON (TLS) schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("default StackSpec validates against stack-spec schema", () => {
    const spec = createDefaultStackSpec();
    const validate = ajv.compile(stackSpecSchema);
    const valid = validate(spec);
    if (!valid) {
      console.error("StackSpec schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("StackSpec with custom channels validates against schema", () => {
    const spec = createDefaultStackSpec();
    spec.channels["slack"] = {
      enabled: true,
      exposure: "lan",
      image: "slack:latest",
      containerPort: 8500,
      config: { SLACK_TOKEN: "test" },
    };
    const validate = ajv.compile(stackSpecSchema);
    const valid = validate(spec);
    if (!valid) {
      console.error("StackSpec (custom) schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });
});

describe("seed caddy.json validation", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  it("packages/lib/src/embedded/state/caddy/caddy.json is valid JSON and validates against caddy schema", async () => {
    const seedPath = join(process.cwd(), "packages/lib/src/embedded/state/caddy/caddy.json");
    const content = await Bun.file(seedPath).text();
    const parsed = JSON.parse(content);

    const validate = ajv.compile(caddyConfigSchema);
    const valid = validate(parsed);
    if (!valid) {
      console.error("Seed caddy.json schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("seed caddy.json has API route and admin fallback", async () => {
    const seedPath = join(process.cwd(), "packages/lib/src/embedded/state/caddy/caddy.json");
    const content = await Bun.file(seedPath).text();
    const parsed = JSON.parse(content);
    expect(parsed.admin.disabled).toBe(true);
    const routes = parsed.apps.http.servers.main.routes;
    // First route should be /api*
    expect(routes[0].match[0].path).toContain("/api*");
    // Last route should proxy to admin
    const lastRoute = routes[routes.length - 1];
    const json = JSON.stringify(lastRoute);
    expect(json).toContain("reverse_proxy");
    expect(json).toContain("admin:8100");
  });
});

describe("compose helpers", () => {
  it("substituteComposeVariables replaces variable references", () => {
    const input = 'image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}';
    const result = substituteComposeVariables(input);
    expect(result).toBe("image: openpalm/admin:latest");
  });

  it("substituteComposeVariables replaces bare variables with placeholder", () => {
    const input = "user: ${OPENPALM_UID}:${OPENPALM_GID}";
    const result = substituteComposeVariables(input);
    expect(result).toBe("user: placeholder:placeholder");
  });

  it("substituteComposeVariables replaces $ prefix variables", () => {
    const input = "$HOME/openpalm:/work";
    const result = substituteComposeVariables(input);
    expect(result).toBe("placeholder/openpalm:/work");
  });
});
