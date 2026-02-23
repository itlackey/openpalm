import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../../..");

describe("install methods verification", () => {
  // Read all relevant files once
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  const cliDocs = readFileSync(join(ROOT, "docs/cli.md"), "utf-8");
  const installSh = readFileSync(join(ROOT, "packages/cli/scripts/install.sh"), "utf-8");
  const installPs1 = readFileSync(join(ROOT, "packages/cli/scripts/install.ps1"), "utf-8");
  const pkgJson = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf-8"));

  describe("README documents all 4 install methods", () => {
    // Verify each method is shown
    it("documents bash install method", () => {
      expect(readme).toContain("curl -fsSL");
      expect(readme).toContain("install.sh");
      expect(readme).toContain("| bash");
    });

    it("documents PowerShell install method", () => {
      expect(readme).toContain("pwsh");
      expect(readme).toContain("install.ps1");
    });

    it("documents npx install method", () => {
      expect(readme).toContain("npx openpalm install");
    });

    it("documents bunx install method", () => {
      expect(readme).toContain("bunx openpalm install");
    });
  });

  describe("CLI docs documents all 4 install methods", () => {
    it("documents bash install method", () => {
      expect(cliDocs).toContain("curl -fsSL");
      expect(cliDocs).toContain("install.sh");
    });

    it("documents PowerShell install method", () => {
      expect(cliDocs).toContain("pwsh");
      expect(cliDocs).toContain("install.ps1");
    });

    it("documents npx install method", () => {
      expect(cliDocs).toContain("npx openpalm install");
    });

    it("documents bunx install method", () => {
      expect(cliDocs).toContain("bunx openpalm install");
    });
  });

  describe("package.json enables npx/bunx usage", () => {
    it("has correct package name for npx/bunx", () => {
      expect(pkgJson.name).toBe("openpalm");
    });

    it("has bin entry pointing to main.ts", () => {
      expect(pkgJson.bin).toBeDefined();
      expect(pkgJson.bin.openpalm).toBe("./src/main.ts");
    });

    it("has files array including source", () => {
      expect(pkgJson.files).toContain("src/**/*.ts");
    });

    it("is not marked as private", () => {
      expect(pkgJson.private).toBeUndefined();
    });

    it("has engines.bun requirement", () => {
      expect(pkgJson.engines?.bun).toBe(">=1.2.0");
    });
  });

  describe("install.sh is a thin wrapper that downloads the CLI binary", () => {
    it("has shebang for bash", () => {
      expect(installSh.startsWith("#!/usr/bin/env bash")).toBe(true);
    });

    it("uses set -euo pipefail", () => {
      expect(installSh).toContain("set -euo pipefail");
    });

    it("downloads binary from GitHub Releases", () => {
      expect(installSh).toContain("releases/latest/download");
    });

    it("validates binary with version check", () => {
      expect(installSh).toContain("version");
    });

    it("delegates to openpalm install", () => {
      expect(installSh).toContain("openpalm install");
      // Uses exec to replace shell process
      expect(installSh).toContain("exec");
    });

    it("installs binary to ~/.local/bin", () => {
      expect(installSh).toContain(".local/bin");
    });

    it("supports --runtime flag", () => {
      expect(installSh).toContain("--runtime");
    });

    it("supports --no-open flag", () => {
      expect(installSh).toContain("--no-open");
    });

    it("supports --ref flag", () => {
      expect(installSh).toContain("--ref");
    });

    it("has cleanup trap for temp files", () => {
      expect(installSh).toContain("trap cleanup EXIT");
    });

    it("redirects Windows users to PowerShell installer", () => {
      expect(installSh).toContain("windows");
      expect(installSh).toContain("install.ps1");
    });

    it("suggests alternative install methods on download failure", () => {
      expect(installSh).toContain("npx openpalm install");
      expect(installSh).toContain("bunx openpalm install");
    });

    it("does not contain full installer logic (no compose commands)", () => {
      expect(installSh).not.toContain("compose_version_ok");
      expect(installSh).not.toContain("OPENPALM_DATA_HOME");
      expect(installSh).not.toContain("generate_token");
      expect(installSh).not.toContain("ADMIN_TOKEN");
    });
  });

  describe("install.ps1 is a thin wrapper that downloads the CLI binary", () => {
    it("checks for Windows", () => {
      expect(installPs1).toContain("$IsWindows");
    });

    it("redirects non-Windows to bash installer", () => {
      expect(installPs1).toContain("install.sh");
    });

    it("downloads binary from GitHub Releases", () => {
      expect(installPs1).toContain("releases/latest/download");
    });

    it("delegates to openpalm install", () => {
      expect(installPs1).toContain("install");
    });

    it("installs binary to LOCALAPPDATA", () => {
      expect(installPs1).toContain("LOCALAPPDATA");
    });

    it("adds install directory to user PATH", () => {
      expect(installPs1).toContain("SetEnvironmentVariable");
    });

    it("supports -Runtime parameter", () => {
      expect(installPs1).toContain('[ValidateSet("docker", "podman", "orbstack")]');
    });

    it("supports -Ref parameter", () => {
      expect(installPs1).toContain("[string]$Ref");
    });

    it("supports -NoOpen switch", () => {
      expect(installPs1).toContain("[switch]$NoOpen");
    });

    it("suggests alternative install methods on download failure", () => {
      expect(installPs1).toContain("npx openpalm install");
      expect(installPs1).toContain("bunx openpalm install");
    });

    it("does not contain full installer logic (no compose commands)", () => {
      expect(installPs1).not.toContain("Compose-VersionOk");
      expect(installPs1).not.toContain("OPENPALM_DATA_HOME");
      expect(installPs1).not.toContain("New-Token");
      expect(installPs1).not.toContain("ADMIN_TOKEN");
    });
  });

  describe("CLI docs covers all commands", () => {
    const requiredCommands = [
      "install", "uninstall", "update", "start", "stop",
      "restart", "logs", "status", "service", "channel", "automation", "extensions", "admin", "version", "help"
    ];

    for (const cmd of requiredCommands) {
      it(`documents the ${cmd} command`, () => {
        expect(cliDocs).toContain(`### \`${cmd}\``);
      });
    }
  });

  describe("CLI docs covers all install options", () => {
    it("documents --runtime flag", () => {
      expect(cliDocs).toContain("--runtime");
      expect(cliDocs).toContain("docker|podman|orbstack");
    });

    it("documents --no-open flag", () => {
      expect(cliDocs).toContain("--no-open");
    });

  });

  describe("CLI docs covers 2-phase install", () => {
    it("documents Phase 1 (Setup)", () => {
      expect(cliDocs).toContain("Phase 1");
    });

    it("documents Phase 2 (Early UI Access)", () => {
      expect(cliDocs).toContain("Phase 2");
      expect(cliDocs).toContain("Caddy");
      expect(cliDocs).toContain("Admin");
    });
  });

  describe("CLI docs covers uninstall options", () => {
    it("documents --remove-all", () => {
      expect(cliDocs).toContain("--remove-all");
    });

    it("documents --remove-images", () => {
      expect(cliDocs).toContain("--remove-images");
    });

    it("documents --yes", () => {
      expect(cliDocs).toContain("--yes");
    });
  });

  describe("CLI docs covers extensions subcommands", () => {
    it("documents extensions install", () => {
      expect(cliDocs).toContain("extensions install");
    });

    it("documents extensions uninstall", () => {
      expect(cliDocs).toContain("extensions uninstall");
    });

    it("documents extensions list", () => {
      expect(cliDocs).toContain("extensions list");
    });
  });

  describe("CLI docs covers configuration", () => {
    it("documents XDG data directory", () => {
      expect(cliDocs).toContain("~/.local/share/openpalm/");
      expect(cliDocs).toContain("OPENPALM_DATA_HOME");
    });

    it("documents XDG config directory", () => {
      expect(cliDocs).toContain("~/.config/openpalm/");
      expect(cliDocs).toContain("OPENPALM_CONFIG_HOME");
    });

    it("documents XDG state directory", () => {
      expect(cliDocs).toContain("~/.local/state/openpalm/");
      expect(cliDocs).toContain("OPENPALM_STATE_HOME");
    });
  });

  describe("CLI docs covers container runtimes", () => {
    it("documents Docker support", () => {
      expect(cliDocs).toContain("Docker");
    });

    it("documents Podman support", () => {
      expect(cliDocs).toContain("Podman");
    });

    it("documents OrbStack support", () => {
      expect(cliDocs).toContain("OrbStack");
    });

    it("documents auto-detection order", () => {
      const orbstackIdx = cliDocs.indexOf("OrbStack", cliDocs.indexOf("Auto-detection"));
      const dockerIdx = cliDocs.indexOf("Docker", orbstackIdx);
      const podmanIdx = cliDocs.indexOf("Podman", dockerIdx);
      expect(orbstackIdx).toBeGreaterThan(-1);
      expect(dockerIdx).toBeGreaterThan(orbstackIdx);
      expect(podmanIdx).toBeGreaterThan(dockerIdx);
    });
  });

  describe("CLI docs covers building from source", () => {
    it("documents basic build command", () => {
      expect(cliDocs).toContain("bun build packages/cli/src/main.ts --compile");
    });

    it("documents all cross-platform targets including Windows", () => {
      expect(cliDocs).toContain("bun-linux-x64");
      expect(cliDocs).toContain("bun-linux-arm64");
      expect(cliDocs).toContain("bun-darwin-x64");
      expect(cliDocs).toContain("bun-darwin-arm64");
      expect(cliDocs).toContain("bun-windows-x64");
    });
  });
});
