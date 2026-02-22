import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../../..");

describe("install methods verification", () => {
  // Read all relevant files once
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  const cliDocs = readFileSync(join(ROOT, "docs/cli.md"), "utf-8");
  const installSh = readFileSync(join(ROOT, "assets/state/scripts/install.sh"), "utf-8");
  const installPs1 = readFileSync(join(ROOT, "assets/state/scripts/install.ps1"), "utf-8");
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
      expect(pkgJson.engines?.bun).toBe(">=1.0.0");
    });
  });

  describe("install.sh bash installer", () => {
    it("has shebang for bash", () => {
      expect(installSh.startsWith("#!/usr/bin/env bash")).toBe(true);
    });

    it("uses set -euo pipefail", () => {
      expect(installSh).toContain("set -euo pipefail");
    });

    it("tries binary download first (binary mode)", () => {
      expect(installSh).toContain("try_binary_install");
      expect(installSh).toContain("Downloading OpenPalm CLI");
    });

    it("falls back to bash installer if binary unavailable", () => {
      const binaryIdx = installSh.indexOf("try_binary_install");
      const fallbackIdx = installSh.indexOf("using bash installer");
      expect(binaryIdx).toBeGreaterThan(-1);
      expect(fallbackIdx).toBeGreaterThan(-1);
      expect(fallbackIdx).toBeGreaterThan(binaryIdx);
    });

    it("downloads binary from GitHub Releases", () => {
      expect(installSh).toContain("releases/latest/download");
    });

    it("validates binary with version check", () => {
      expect(installSh).toContain("$BINARY_TMP\" version");
    });

    it("delegates to openpalm install after binary download", () => {
      expect(installSh).toContain("$BINARY_TMP\" install");
    });

    it("bash fallback detects container runtime", () => {
      expect(installSh).toContain("detect_runtime");
      expect(installSh).toContain("docker");
      expect(installSh).toContain("podman");
      expect(installSh).toContain("orbstack");
    });

    it("bash fallback generates secure tokens", () => {
      expect(installSh).toContain("generate_token");
      expect(installSh).toContain("ADMIN_TOKEN");
      expect(installSh).toContain("POSTGRES_PASSWORD");
    });

    it("bash fallback creates XDG directories", () => {
      expect(installSh).toContain("OPENPALM_DATA_HOME");
      expect(installSh).toContain("OPENPALM_CONFIG_HOME");
      expect(installSh).toContain("OPENPALM_STATE_HOME");
    });

    it("bash fallback resets setup wizard state on reinstall", () => {
      expect(installSh).toContain("rm -f \"$OPENPALM_DATA_HOME/admin/setup-state.json\"");
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

    it("cleans up binary temp file", () => {
      expect(installSh).toContain("BINARY_TMP");
      expect(installSh).toContain('rm -f "$BINARY_TMP"');
    });

    it("redirects Windows users to PowerShell installer", () => {
      expect(installSh).toContain("windows-bash");
      expect(installSh).toContain("install.ps1");
    });
  });

  describe("install.ps1 PowerShell installer", () => {
    it("validates runtime parameter", () => {
      expect(installPs1).toContain('[ValidateSet("docker", "podman")]');
    });

    it("checks for Windows", () => {
      expect(installPs1).toContain("$IsWindows");
    });

    it("redirects non-Windows to bash installer", () => {
      expect(installPs1).toContain("install.sh");
    });

    it("detects container runtime", () => {
      expect(installPs1).toContain("Detect-Runtime");
    });

    it("generates secure tokens", () => {
      expect(installPs1).toContain("New-Token");
      expect(installPs1).toContain("ADMIN_TOKEN");
    });

    it("creates XDG directories", () => {
      expect(installPs1).toContain("OPENPALM_DATA_HOME");
      expect(installPs1).toContain("OPENPALM_CONFIG_HOME");
      expect(installPs1).toContain("OPENPALM_STATE_HOME");
    });

    it("supports -Ref parameter", () => {
      expect(installPs1).toContain("[string]$Ref");
    });

    it("supports -NoOpen switch", () => {
      expect(installPs1).toContain("[switch]$NoOpen");
    });

    it("documents that binary mode is not available on Windows", () => {
      expect(installPs1).toContain("does not support binary mode");
    });

    it("has cleanup in finally block", () => {
      expect(installPs1).toContain("finally");
      expect(installPs1).toContain("Remove-Item");
    });
  });

  describe("CLI docs covers all commands", () => {
    const requiredCommands = [
      "install", "uninstall", "update", "start", "stop",
      "restart", "logs", "status", "extensions", "version", "help"
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

    it("documents --ref flag", () => {
      expect(cliDocs).toContain("--ref");
    });
  });

  describe("CLI docs covers 4-phase install", () => {
    it("documents Phase 1 (Setup)", () => {
      expect(cliDocs).toContain("Phase 1");
    });

    it("documents Phase 2 (Core Services)", () => {
      expect(cliDocs).toContain("Phase 2");
      expect(cliDocs).toContain("Caddy");
      expect(cliDocs).toContain("PostgreSQL");
      expect(cliDocs).toContain("Admin");
    });

    it("documents Phase 3 (Image Preparation)", () => {
      expect(cliDocs).toContain("Phase 3");
    });

    it("documents Phase 4 (Full Stack)", () => {
      expect(cliDocs).toContain("Phase 4");
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

    it("documents all 4 cross-platform targets", () => {
      expect(cliDocs).toContain("bun-linux-x64");
      expect(cliDocs).toContain("bun-linux-arm64");
      expect(cliDocs).toContain("bun-darwin-x64");
      expect(cliDocs).toContain("bun-darwin-arm64");
    });
  });
});
