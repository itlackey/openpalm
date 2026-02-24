import { existsSync, accessSync, constants } from "node:fs";
import type { StackManagerPaths } from "./stack-manager.ts";
import { composePull } from "./compose-runner.ts";
import { parseYamlDocument } from "../shared/yaml.ts";
import { checkDiskSpace } from "../preflight.ts";

export type PreflightFailure = { check: string; message: string; detail?: string };
export type PreflightResult = { failures: PreflightFailure[]; warnings: string[] };

export function extractPublishedPorts(composeContent: string): number[] {
  const doc = parseYamlDocument(composeContent) as Record<string, unknown>;
  const services = (doc.services ?? {}) as Record<string, Record<string, unknown>>;
  const ports: number[] = [];
  for (const svc of Object.values(services)) {
    const entries = (svc.ports ?? []) as Array<string | number>;
    for (const entry of entries) {
      if (typeof entry === "number") {
        ports.push(entry);
        continue;
      }
      if (typeof entry !== "string") continue;
      const parts = entry.split(":");
      if (parts.length >= 2) {
        const host = Number(parts[parts.length - 2]);
        if (Number.isInteger(host)) ports.push(host);
      }
    }
  }
  return Array.from(new Set(ports));
}

export async function checkDockerSocket(socketUri: string, bin: string): Promise<PreflightFailure | null> {
  if (!socketUri.startsWith("unix://")) return null;
  const socketPath = socketUri.replace("unix://", "");
  if (!existsSync(socketPath)) {
    return { check: "docker_socket", message: "Docker socket not found", detail: socketPath };
  }
  try {
    accessSync(socketPath, constants.R_OK | constants.W_OK);
  } catch {
    return { check: "docker_socket", message: "Docker socket not accessible", detail: socketPath };
  }
  try {
    const proc = Bun.spawn([bin, "info"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    if (proc.exitCode !== 0) return { check: "docker_socket", message: "Docker daemon not reachable" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { check: "docker_socket", message };
  }
  return null;
}

export async function checkPortsAvailable(ports: number[]): Promise<PreflightFailure[]> {
  if (process.env.OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS === "1") return [];
  const failures: PreflightFailure[] = [];
  for (const port of ports) {
    try {
      const proc = Bun.spawn(["ss", "-tln"], { stdout: "pipe", stderr: "ignore" });
      await proc.exited;
      const output = await new Response(proc.stdout).text();
      if (output.includes(`:${port} `)) {
        failures.push({ check: "port", message: `Port ${port} is already in use` });
      }
    } catch {
      // ignore if ss unavailable
    }
  }
  return failures;
}

export function checkWritableMounts(paths: StackManagerPaths): PreflightFailure[] {
  const targets = [paths.stateRootPath, paths.caddyJsonPath, paths.composeFilePath, paths.systemEnvPath];
  const failures: PreflightFailure[] = [];
  for (const target of targets) {
    try {
      accessSync(target, constants.W_OK);
    } catch {
      failures.push({ check: "writable_mount", message: "Path not writable", detail: target });
    }
  }
  return failures;
}

export async function checkImageAvailability(services: string[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const service of services) {
    const result = await composePull(service);
    if (!result.ok) warnings.push(`image_pull_failed:${service}:${result.stderr || "unknown"}`);
  }
  return warnings;
}

export async function runApplyPreflight(args: {
  composeContent: string;
  paths: StackManagerPaths;
  socketUri: string;
  composeBin: string;
  pullServices: string[];
}): Promise<PreflightResult> {
  const failures: PreflightFailure[] = [];
  const warnings: string[] = [];
  const ports = extractPublishedPorts(args.composeContent);
  failures.push(...(await checkPortsAvailable(ports)));
  failures.push(...checkWritableMounts(args.paths));
  const socketFailure = await checkDockerSocket(args.socketUri, args.composeBin);
  if (socketFailure) failures.push(socketFailure);
  const diskWarning = await checkDiskSpace();
  if (diskWarning) warnings.push(diskWarning.message);
  warnings.push(...await checkImageAvailability(args.pullServices));
  return { failures, warnings };
}
