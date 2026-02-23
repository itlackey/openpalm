import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { generateStackArtifacts } from "./stack-generator.ts";
import { createDefaultStackSpec } from "./stack-spec.ts";
import { validateStackSpec, validateCaddyConfig, validateComposeFile } from "./schema-validation.ts";
import { stackSpecSchema } from "./schemas/stack-spec.schema.ts";
import { caddyConfigSchema } from "./schemas/caddy-config.schema.ts";
import { substituteComposeVariables } from "./schemas/compose-helpers.ts";

describe("runtime validators", () => {
  it("validateStackSpec accepts valid default spec", () => {
    const spec = createDefaultStackSpec();
    const result = validateStackSpec(spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validateStackSpec rejects invalid spec", () => {
    const result = validateStackSpec({ version: 99, accessScope: "bogus" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validateStackSpec rejects non-object input", () => {
    const result = validateStackSpec("not an object");
    expect(result.valid).toBe(false);
  });

  it("validateCaddyConfig accepts valid generated config", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const result = validateCaddyConfig(caddyConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validateCaddyConfig rejects missing admin block", () => {
    const result = validateCaddyConfig({ apps: { http: { servers: {} } } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("admin"))).toBe(true);
  });

  it("validateCaddyConfig rejects non-object input", () => {
    const result = validateCaddyConfig(null);
    expect(result.valid).toBe(false);
  });

  it("validateComposeFile accepts valid generated compose", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const result = validateComposeFile(out.composeFile);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validateComposeFile rejects content without services block", () => {
    const result = validateComposeFile("networks:\n  default:\n");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("services"))).toBe(true);
  });
});

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

describe("schema validation edge cases", () => {
  it("validateCaddyConfig rejects config with unknown handler type", () => {
    const config = {
      admin: { disabled: true },
      apps: {
        http: {
          servers: {
            main: {
              listen: [":80"],
              routes: [{
                handle: [{ handler: "unknown_handler" }],
              }],
            },
          },
        },
      },
    };
    const result = validateCaddyConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("unknown handler type"))).toBe(true);
  });

  it("validateCaddyConfig rejects config with missing listen array", () => {
    const config = {
      admin: { disabled: true },
      apps: {
        http: {
          servers: {
            main: { routes: [] },
          },
        },
      },
    };
    const result = validateCaddyConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("listen"))).toBe(true);
  });

  it("validateCaddyConfig rejects config with missing routes", () => {
    const config = {
      admin: { disabled: true },
      apps: {
        http: {
          servers: {
            main: { listen: [":80"] },
          },
        },
      },
    };
    const result = validateCaddyConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("routes"))).toBe(true);
  });

  it("validateCaddyConfig rejects route with non-array handle", () => {
    const config = {
      admin: { disabled: true },
      apps: {
        http: {
          servers: {
            main: {
              listen: [":80"],
              routes: [{ handle: "not-array" }],
            },
          },
        },
      },
    };
    const result = validateCaddyConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("handle must be an array"))).toBe(true);
  });

  it("validateCaddyConfig accepts config with admin.disabled = true and empty routes", () => {
    const config = {
      admin: { disabled: true },
      apps: {
        http: {
          servers: {
            main: { listen: [":80"], routes: [] },
          },
        },
      },
    };
    const result = validateCaddyConfig(config);
    expect(result.valid).toBe(true);
  });

  it("validateComposeFile rejects malformed YAML", () => {
    const result = validateComposeFile("  :\n  bad: [unclosed");
    expect(result.valid).toBe(false);
  });

  it("validateComposeFile accepts compose with standard service keys", () => {
    const yaml = `services:
  web:
    image: nginx
    restart: always
    ports:
      - "80:80"
    volumes:
      - ./data:/data
    networks:
      - default
`;
    const result = validateComposeFile(yaml);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validateStackSpec rejects spec with missing channels", () => {
    const result = validateStackSpec({ version: 2, accessScope: "lan" });
    expect(result.valid).toBe(false);
  });
});

describe("seed caddy.json validation", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  it("assets/state/caddy/caddy.json is valid JSON and validates against caddy schema", async () => {
    const seedPath = join(process.cwd(), "assets/state/caddy/caddy.json");
    const content = await Bun.file(seedPath).text();
    const parsed = JSON.parse(content);

    // Runtime validator
    const runtimeResult = validateCaddyConfig(parsed);
    expect(runtimeResult.valid).toBe(true);

    // ajv schema validator
    const validate = ajv.compile(caddyConfigSchema);
    const valid = validate(parsed);
    if (!valid) {
      console.error("Seed caddy.json schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });


  it("assets/state/caddy/fallback-caddy.json is valid JSON and validates against caddy schema", async () => {
    const seedPath = join(process.cwd(), "assets/state/caddy/fallback-caddy.json");
    const content = await Bun.file(seedPath).text();
    const parsed = JSON.parse(content);

    const runtimeResult = validateCaddyConfig(parsed);
    expect(runtimeResult.valid).toBe(true);

    const validate = ajv.compile(caddyConfigSchema);
    const valid = validate(parsed);
    if (!valid) {
      console.error("Fallback caddy.json schema errors:", validate.errors);
    }
    expect(valid).toBe(true);
  });

  it("seed caddy.json has API route and admin fallback", async () => {
    const seedPath = join(process.cwd(), "assets/state/caddy/caddy.json");
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
