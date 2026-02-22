import { parseStackSpec } from "./stack-spec.ts";

export type ValidationResult = {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
};

/**
 * Runtime validator for StackSpec. Delegates to parseStackSpec() which throws
 * on validation errors. Returns a ValidationResult wrapping the result.
 */
export function validateStackSpec(data: unknown): ValidationResult {
  try {
    parseStackSpec(data);
    return { valid: true, errors: [] };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      valid: false,
      errors: [{ path: "/", message }],
    };
  }
}

/**
 * Runtime structural validator for Caddy JSON API config.
 * Checks required fields and valid handler/matcher types without external deps.
 */
export function validateCaddyConfig(data: unknown): ValidationResult {
  const errors: Array<{ path: string; message: string }> = [];

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { valid: false, errors: [{ path: "/", message: "must be an object" }] };
  }
  const doc = data as Record<string, unknown>;

  // admin
  if (typeof doc.admin !== "object" || doc.admin === null) {
    errors.push({ path: "/admin", message: "missing or invalid admin block" });
  } else {
    const admin = doc.admin as Record<string, unknown>;
    if (admin.disabled !== true) {
      errors.push({ path: "/admin/disabled", message: "admin.disabled must be true" });
    }
  }

  // apps
  if (typeof doc.apps !== "object" || doc.apps === null) {
    errors.push({ path: "/apps", message: "missing or invalid apps block" });
    return { valid: false, errors };
  }
  const apps = doc.apps as Record<string, unknown>;

  // apps.http
  if (typeof apps.http !== "object" || apps.http === null) {
    errors.push({ path: "/apps/http", message: "missing or invalid http block" });
    return { valid: false, errors };
  }
  const http = apps.http as Record<string, unknown>;

  // apps.http.servers
  if (typeof http.servers !== "object" || http.servers === null) {
    errors.push({ path: "/apps/http/servers", message: "missing or invalid servers block" });
    return { valid: false, errors };
  }
  const servers = http.servers as Record<string, unknown>;

  const validHandlerTypes = new Set(["reverse_proxy", "subroute", "rewrite", "static_response"]);

  for (const [serverName, server] of Object.entries(servers)) {
    if (typeof server !== "object" || server === null) {
      errors.push({ path: `/apps/http/servers/${serverName}`, message: "server must be an object" });
      continue;
    }
    const srv = server as Record<string, unknown>;

    if (!Array.isArray(srv.listen)) {
      errors.push({ path: `/apps/http/servers/${serverName}/listen`, message: "listen must be an array" });
    }
    if (!Array.isArray(srv.routes)) {
      errors.push({ path: `/apps/http/servers/${serverName}/routes`, message: "routes must be an array" });
      continue;
    }

    for (let i = 0; i < srv.routes.length; i++) {
      const route = srv.routes[i] as Record<string, unknown>;
      if (!Array.isArray(route.handle)) {
        errors.push({ path: `/apps/http/servers/${serverName}/routes/${i}/handle`, message: "handle must be an array" });
        continue;
      }
      for (let j = 0; j < route.handle.length; j++) {
        const handler = route.handle[j] as Record<string, unknown>;
        if (typeof handler.handler !== "string") {
          errors.push({ path: `/apps/http/servers/${serverName}/routes/${i}/handle/${j}/handler`, message: "handler type must be a string" });
        } else if (!validHandlerTypes.has(handler.handler)) {
          errors.push({ path: `/apps/http/servers/${serverName}/routes/${i}/handle/${j}/handler`, message: `unknown handler type: ${handler.handler}` });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Runtime structural validator for Docker Compose files.
 * Parses YAML and checks that the document has a services block with valid structure.
 */
export function validateComposeFile(yamlString: string): ValidationResult {
  const errors: Array<{ path: string; message: string }> = [];

  let doc: unknown;
  try {
    // Use Bun.YAML if available, otherwise fall back to basic YAML parsing
    if (typeof Bun !== "undefined" && "YAML" in Bun) {
      doc = (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(yamlString);
    } else {
      // Fallback: check structure via line parsing
      return validateComposeFileBasic(yamlString);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { valid: false, errors: [{ path: "/", message: `YAML parse error: ${message}` }] };
  }

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { valid: false, errors: [{ path: "/", message: "must be an object" }] };
  }

  const root = doc as Record<string, unknown>;
  if (typeof root.services !== "object" || root.services === null) {
    errors.push({ path: "/services", message: "missing or invalid services block" });
    return { valid: errors.length === 0, errors };
  }

  const services = root.services as Record<string, unknown>;
  const validServiceKeys = new Set([
    "image", "build", "restart", "env_file", "environment", "ports", "volumes",
    "networks", "depends_on", "healthcheck", "command", "entrypoint", "working_dir",
    "user", "profiles", "labels", "logging", "deploy", "cap_add", "cap_drop",
    "privileged", "read_only", "tmpfs", "stdin_open", "tty", "container_name",
    "hostname", "extra_hosts", "dns", "dns_search", "devices", "security_opt",
    "ulimits", "sysctls", "shm_size", "stop_grace_period", "stop_signal",
    "platform", "pull_policy", "init", "configs", "secrets",
  ]);

  for (const [svcName, svc] of Object.entries(services)) {
    if (typeof svc !== "object" || svc === null) {
      errors.push({ path: `/services/${svcName}`, message: "service must be an object" });
      continue;
    }
    const svcObj = svc as Record<string, unknown>;
    for (const key of Object.keys(svcObj)) {
      if (!validServiceKeys.has(key)) {
        errors.push({ path: `/services/${svcName}/${key}`, message: `unknown service key: ${key}` });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Basic compose validation without YAML parser — checks structure via line parsing */
function validateComposeFileBasic(content: string): ValidationResult {
  const errors: Array<{ path: string; message: string }> = [];
  const lines = content.split(/\r?\n/);
  let hasServices = false;

  for (const line of lines) {
    if (line.trim() === "services:") {
      hasServices = true;
      break;
    }
  }

  if (!hasServices) {
    errors.push({ path: "/services", message: "missing services block" });
  }

  return { valid: errors.length === 0, errors };
}
