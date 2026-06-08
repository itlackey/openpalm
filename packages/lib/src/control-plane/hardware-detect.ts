// Host GPU / VRAM detection for setup recommendations.
//
// Data-driven on purpose: each entry in GPU_PROBES is a vendor + a command to
// run + a pure parser. Adding a new accelerator (Intel Arc, Apple Metal, a new
// rocm/CUDA query, etc.) is a one-entry change here — nothing downstream needs to
// know. detectGpu() runs every probe, ignores the ones whose tool is absent, and
// returns the single best (highest-VRAM) result, or null when no GPU is found.

import { execFile } from "node:child_process";
import { createLogger } from "../logger.js";

const logger = createLogger("hardware-detect");

export type GpuVendor = "nvidia" | "amd" | "unknown";

export type GpuInfo = {
  vendor: GpuVendor;
  /** Human-readable adapter name, e.g. "NVIDIA GeForce RTX 4090". */
  name: string;
  /** Total VRAM in MiB. 0 when the tool reported the GPU but not its memory. */
  vramMb: number;
};

type GpuProbe = {
  vendor: GpuVendor;
  command: string;
  args: string[];
  /** Pure parser: tool stdout -> detected GPUs. Must not throw. */
  parse: (stdout: string) => GpuInfo[];
};

/** Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(stdout: string): GpuInfo[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): GpuInfo | null => {
      // "NVIDIA GeForce RTX 4090, 24564"
      const idx = line.lastIndexOf(",");
      if (idx === -1) return null;
      const name = line.slice(0, idx).trim();
      const vramMb = Number.parseInt(line.slice(idx + 1).trim(), 10);
      if (!name || !Number.isFinite(vramMb)) return null;
      return { vendor: "nvidia", name, vramMb };
    })
    .filter((g): g is GpuInfo => g !== null);
}

/** Parse `rocm-smi --showmeminfo vram --showproductname --json`. */
export function parseRocmSmi(stdout: string): GpuInfo[] {
  let doc: Record<string, Record<string, string>>;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return [];
  }
  const out: GpuInfo[] = [];
  for (const card of Object.values(doc)) {
    if (!card || typeof card !== "object") continue;
    // rocm-smi key names drift across versions — match loosely.
    const vramKey = Object.keys(card).find((k) => /vram total memory/i.test(k));
    const nameKey = Object.keys(card).find((k) => /product name|card series|gfx/i.test(k));
    const bytes = vramKey ? Number.parseInt(String(card[vramKey]).trim(), 10) : NaN;
    const vramMb = Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : 0;
    out.push({ vendor: "amd", name: nameKey ? String(card[nameKey]).trim() : "AMD GPU", vramMb });
  }
  return out;
}

const GPU_PROBES: GpuProbe[] = [
  {
    vendor: "nvidia",
    command: "nvidia-smi",
    args: ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    parse: parseNvidiaSmi,
  },
  {
    vendor: "amd",
    command: "rocm-smi",
    args: ["--showmeminfo", "vram", "--showproductname", "--json"],
    parse: parseRocmSmi,
  },
];

function run(command: string, args: string[], timeoutMs = 3_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (err, stdout) => {
      // ENOENT (tool not installed) and any non-zero exit -> not available.
      resolve(err ? null : stdout?.toString() ?? "");
    });
  });
}

/**
 * Detect the host's best GPU. Returns the highest-VRAM adapter across all probes,
 * or null when none is found. Never throws.
 */
export async function detectGpu(): Promise<GpuInfo | null> {
  const found: GpuInfo[] = [];
  await Promise.all(
    GPU_PROBES.map(async (probe) => {
      const stdout = await run(probe.command, probe.args);
      if (stdout === null) return;
      try {
        found.push(...probe.parse(stdout));
      } catch (error) {
        logger.debug("gpu probe parse failed", { vendor: probe.vendor, error: String(error) });
      }
    }),
  );
  if (found.length === 0) return null;
  return found.reduce((best, g) => (g.vramMb > best.vramMb ? g : best));
}
