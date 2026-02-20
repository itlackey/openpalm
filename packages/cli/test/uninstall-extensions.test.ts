import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "../src/commands");

// Read source files once for all tests
const uninstallSource = readFileSync(
  join(SRC_DIR, "uninstall.ts"),
  "utf-8"
);
const extensionsSource = readFileSync(
  join(SRC_DIR, "extensions.ts"),
  "utf-8"
);

describe("uninstall command source validation", () => {
  it("loads config from XDG state .env", () => {
    // Validates that source calls resolveXDGPaths() and reads .env from state directory
    expect(uninstallSource).toContain("resolveXDGPaths()");
    expect(uninstallSource).toContain("join(xdg.state, \".env\")");
    expect(uninstallSource).toContain("await readEnvFile(stateEnvPath)");
  });

  it("falls back to CWD .env if state .env fails", () => {
    // Validates fallback mechanism when state .env doesn't exist
    expect(uninstallSource).toContain('await readEnvFile(".env")');
    // Should be in a catch block after trying stateEnvPath
    const stateEnvIndex = uninstallSource.indexOf(
      "await readEnvFile(stateEnvPath)"
    );
    const cwdEnvIndex = uninstallSource.indexOf('await readEnvFile(".env")');
    expect(stateEnvIndex).toBeGreaterThan(-1);
    expect(cwdEnvIndex).toBeGreaterThan(stateEnvIndex);
  });

  it("supports --runtime override", () => {
    // Validates that options.runtime is checked and used
    expect(uninstallSource).toContain("options.runtime");
    expect(uninstallSource).toContain("if (options.runtime)");
    expect(uninstallSource).toContain("platform = options.runtime");
  });

  it("auto-detects runtime from env or system", () => {
    // Validates auto-detection logic
    expect(uninstallSource).toContain("env.OPENPALM_CONTAINER_PLATFORM");
    expect(uninstallSource).toContain("detectRuntime");
    expect(uninstallSource).toContain("detectOS()");
  });

  it("prompts for confirmation by default", () => {
    // Validates that confirm() is called
    expect(uninstallSource).toContain("await confirm(");
  });

  it("skips confirmation with --yes flag", () => {
    // Validates that --yes option skips confirmation prompt
    expect(uninstallSource).toContain("if (!options.yes)");
    expect(uninstallSource).toContain("await confirm(");
    // The confirm should be inside the !options.yes check
    const yesCheckIndex = uninstallSource.indexOf("if (!options.yes)");
    const confirmIndex = uninstallSource.indexOf("await confirm(");
    expect(yesCheckIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(yesCheckIndex);
  });

  it("calls composeDown with remove-orphans", () => {
    // Validates that composeDown is called with removeOrphans: true
    expect(uninstallSource).toContain("await composeDown(config, {");
    expect(uninstallSource).toContain("removeOrphans: true");
  });

  it("supports --remove-images to rmi all", () => {
    // Validates that removeImages option is passed through
    expect(uninstallSource).toContain("removeImages: options.removeImages");
    expect(uninstallSource).toContain(
      "Remove images: ${options.removeImages ? \"yes\" : \"no\"}"
    );
  });

  it("removes XDG dirs with --remove-all", () => {
    // Validates that data, config, and state directories are removed
    expect(uninstallSource).toContain("if (options.removeAll)");
    expect(uninstallSource).toContain(
      "await rm(xdg.data, { recursive: true, force: true })"
    );
    expect(uninstallSource).toContain(
      "await rm(xdg.config, { recursive: true, force: true })"
    );
    expect(uninstallSource).toContain(
      "await rm(xdg.state, { recursive: true, force: true })"
    );
  });

  it("removes CWD .env with --remove-all", () => {
    // Validates that .env in current directory is removed
    expect(uninstallSource).toContain("if (options.removeAll)");
    expect(uninstallSource).toContain('await unlink(".env")');
    // unlink should be after the removeAll check
    const removeAllIndex = uninstallSource.indexOf("if (options.removeAll)");
    const unlinkIndex = uninstallSource.indexOf('await unlink(".env")');
    expect(unlinkIndex).toBeGreaterThan(removeAllIndex);
  });

  it("prints uninstall summary before proceeding", () => {
    // Validates that summary information is printed
    expect(uninstallSource).toContain('"Uninstall Summary:"');
    expect(uninstallSource).toContain("Runtime platform:");
    expect(uninstallSource).toContain("Stop/remove containers:");
    expect(uninstallSource).toContain("Remove images:");
    expect(uninstallSource).toContain("Remove all data/config/state:");
    expect(uninstallSource).toContain("Data directory:");
    expect(uninstallSource).toContain("Config directory:");
    expect(uninstallSource).toContain("State directory:");
    // Summary should be printed before confirm
    const summaryIndex = uninstallSource.indexOf('"Uninstall Summary:"');
    const confirmIndex = uninstallSource.indexOf("await confirm(");
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeLessThan(confirmIndex);
  });
});

describe("extensions command source validation", () => {
  it("reads admin token from Bun.env first", () => {
    // Validates that Bun.env.ADMIN_TOKEN is checked first
    expect(extensionsSource).toContain("Bun.env.ADMIN_TOKEN");
    expect(extensionsSource).toContain("let adminToken = Bun.env.ADMIN_TOKEN");
  });

  it("falls back to state .env for admin token", () => {
    // Validates fallback to reading from state .env
    expect(extensionsSource).toContain("if (!adminToken)");
    expect(extensionsSource).toContain("resolveXDGPaths().state");
    expect(extensionsSource).toContain("await readEnvFile(stateEnvPath)");
    expect(extensionsSource).toContain("adminToken = envVars.ADMIN_TOKEN");
  });

  it("uses correct base URL fallback chain", () => {
    // Validates the URL fallback: ADMIN_APP_URL -> GATEWAY_URL -> localhost
    expect(extensionsSource).toContain("Bun.env.ADMIN_APP_URL");
    expect(extensionsSource).toContain("Bun.env.GATEWAY_URL");
    expect(extensionsSource).toContain('"http://localhost/admin"');
    // Should use nullish coalescing operator (??) for fallback chain
    expect(extensionsSource).toContain("??");
  });

  it("install subcommand POSTs to /admin/gallery/install", () => {
    // Validates install endpoint and method
    expect(extensionsSource).toContain('case "install"');
    expect(extensionsSource).toContain('`${base}/admin/gallery/install`');
    expect(extensionsSource).toContain('method: "POST"');
  });

  it("uninstall subcommand POSTs to /admin/gallery/uninstall", () => {
    // Validates uninstall endpoint and method
    expect(extensionsSource).toContain('case "uninstall"');
    expect(extensionsSource).toContain('`${base}/admin/gallery/uninstall`');
    expect(extensionsSource).toContain('method: "POST"');
  });

  it("list subcommand GETs /admin/installed", () => {
    // Validates list endpoint and method
    expect(extensionsSource).toContain('case "list"');
    expect(extensionsSource).toContain('`${base}/admin/installed`');
    expect(extensionsSource).toContain('method: "GET"');
  });

  it("install requires --plugin argument", () => {
    // Validates that install checks for plugin argument
    expect(extensionsSource).toContain('case "install"');
    expect(extensionsSource).toContain('const pluginId = getArg("plugin")');
    expect(extensionsSource).toContain("if (!pluginId)");
    expect(extensionsSource).toContain('"--plugin <id> is required for install"');
  });

  it("uninstall requires --plugin argument", () => {
    // Validates that uninstall checks for plugin argument
    expect(extensionsSource).toContain('case "uninstall"');
    expect(extensionsSource).toContain('const pluginId = getArg("plugin")');
    expect(extensionsSource).toContain("if (!pluginId)");
    expect(extensionsSource).toContain(
      '"--plugin <id> is required for uninstall"'
    );
  });

  it("sends x-admin-token header", () => {
    // Validates authentication header
    expect(extensionsSource).toContain('"x-admin-token"');
    expect(extensionsSource).toContain('"x-admin-token": adminToken');
  });

  it("sends content-type json header", () => {
    // Validates content-type header
    expect(extensionsSource).toContain('"content-type"');
    expect(extensionsSource).toContain('"content-type": "application/json"');
  });

  it("sends pluginId in request body", () => {
    // Validates request body structure
    expect(extensionsSource).toContain("JSON.stringify({ pluginId })");
    expect(extensionsSource).toContain("body: JSON.stringify({ pluginId })");
  });

  it("validates HTTP response status before printing result", () => {
    // Validates that response.ok is checked via checkResponse
    expect(extensionsSource).toContain("checkResponse(response");
    expect(extensionsSource).toContain("if (!response.ok)");
    expect(extensionsSource).toContain("response.status");
    expect(extensionsSource).toContain("response.statusText");
  });

  it("prints error for unknown subcommand", () => {
    // Validates default case handling
    expect(extensionsSource).toContain("default:");
    expect(extensionsSource).toContain(
      'error(`Unknown subcommand: ${subcommand}`)'
    );
    expect(extensionsSource).toContain(
      '"Usage: openpalm extensions <install|uninstall|list> [--plugin <id>]"'
    );
  });
});
