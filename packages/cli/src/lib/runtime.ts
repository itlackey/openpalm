import type { ContainerPlatform, HostOS, HostArch } from "../types.ts";
import { homedir } from "node:os";
import { join } from "node:path";

export function detectOS(): HostOS {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows-bash";
    default:
      return "unknown";
  }
}

export function detectArch(): HostArch {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      return "amd64";
  }
}

export async function detectRuntime(os: HostOS): Promise<ContainerPlatform | null> {
  // Check for OrbStack on macOS
  if (os === "macos") {
    const orbstackSocket = join(homedir(), ".orbstack", "run", "docker.sock");
    const orbstackExists = await Bun.file(orbstackSocket).exists();
    const dockerBin = await Bun.which("docker");
    if (orbstackExists && dockerBin) {
      return "orbstack";
    }
  }

  // Check for docker
  const dockerBin = await Bun.which("docker");
  if (dockerBin) {
    return "docker";
  }

  // Check for podman
  const podmanBin = await Bun.which("podman");
  if (podmanBin) {
    return "podman";
  }

  return null;
}

export function resolveSocketPath(platform: ContainerPlatform, os: HostOS): string {
  switch (platform) {
    case "docker":
      return "/var/run/docker.sock";
    case "orbstack":
      try {
        return join(homedir(), ".orbstack", "run", "docker.sock");
      } catch {
        return "/var/run/docker.sock";
      }
    case "podman":
      if (os === "linux") {
        const uid = process.getuid?.() ?? 1000;
        return `/run/user/${uid}/podman/podman.sock`;
      }
      return "/var/run/docker.sock";
  }
}

export function resolveComposeBin(platform: ContainerPlatform): { bin: string; subcommand: string } {
  switch (platform) {
    case "docker":
    case "orbstack":
      return { bin: "docker", subcommand: "compose" };
    case "podman":
      return { bin: "podman", subcommand: "compose" };
  }
}

export async function validateRuntime(bin: string, subcommand: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([bin, subcommand, "version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
