import { test, expect, describe } from "bun:test";
import {
  recommendSetup,
  gpuToProfileVariant,
  MIN_LOCAL_GPU_VRAM_MB,
  type SetupRecommendationInput,
} from "./setup-recommendation.js";
import { parseNvidiaSmi, parseRocmSmi, type GpuInfo } from "./hardware-detect.js";

const base: SetupRecommendationInput = { cloudProviders: [], hostProviders: [], gpu: null };
const gpu = (vendor: GpuInfo["vendor"], vramMb: number, name = "Test GPU"): GpuInfo => ({ vendor, name, vramMb });

describe("recommendSetup", () => {
  test("cloud provider connected -> use-cloud (wins over everything)", () => {
    const r = recommendSetup({
      cloudProviders: ["openai"],
      hostProviders: [{ provider: "ollama", url: "x" }],
      gpu: gpu("nvidia", 24576),
    });
    expect(r.action).toBe("use-cloud");
  });

  test("no cloud, host provider running -> use-host-providers", () => {
    const r = recommendSetup({ ...base, hostProviders: [{ provider: "ollama", url: "http://host:11434" }], gpu: gpu("nvidia", 24576) });
    expect(r.action).toBe("use-host-providers");
    if (r.action === "use-host-providers") expect(r.alert).toContain("ollama");
  });

  test("host providers win over GPU enable-ollama", () => {
    const r = recommendSetup({ ...base, hostProviders: [{ provider: "lmstudio", url: "x" }], gpu: gpu("nvidia", 24576) });
    expect(r.action).toBe("use-host-providers");
  });

  test("no cloud, no host, capable nvidia GPU -> enable-ollama cuda", () => {
    const r = recommendSetup({ ...base, gpu: gpu("nvidia", 12288) });
    expect(r.action).toBe("enable-ollama");
    if (r.action === "enable-ollama") expect(r.profileVariant).toBe("cuda");
  });

  test("capable amd GPU -> enable-ollama rocm", () => {
    const r = recommendSetup({ ...base, gpu: gpu("amd", 16384) });
    if (r.action === "enable-ollama") expect(r.profileVariant).toBe("rocm");
    else throw new Error("expected enable-ollama");
  });

  test("VRAM exactly at threshold -> enable-ollama", () => {
    const r = recommendSetup({ ...base, gpu: gpu("nvidia", MIN_LOCAL_GPU_VRAM_MB) });
    expect(r.action).toBe("enable-ollama");
  });

  test("VRAM just under threshold -> connect-manually", () => {
    const r = recommendSetup({ ...base, gpu: gpu("nvidia", MIN_LOCAL_GPU_VRAM_MB - 1) });
    expect(r.action).toBe("connect-manually");
  });

  test("no cloud, no host, no GPU -> connect-manually", () => {
    const r = recommendSetup(base);
    expect(r.action).toBe("connect-manually");
    if (r.action === "connect-manually") expect(r.alert).toContain("custom OpenAI-compatible");
  });
});

describe("gpuToProfileVariant", () => {
  test("nvidia->cuda, amd->rocm, unknown->cpu", () => {
    expect(gpuToProfileVariant(gpu("nvidia", 8192))).toBe("cuda");
    expect(gpuToProfileVariant(gpu("amd", 8192))).toBe("rocm");
    expect(gpuToProfileVariant(gpu("unknown", 8192))).toBe("cpu");
  });
});

describe("parseNvidiaSmi", () => {
  test("parses name + VRAM (MiB), handles commas in name", () => {
    const out = parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564\nNVIDIA A100, 81920\n");
    expect(out).toEqual([
      { vendor: "nvidia", name: "NVIDIA GeForce RTX 4090", vramMb: 24564 },
      { vendor: "nvidia", name: "NVIDIA A100", vramMb: 81920 },
    ]);
  });
  test("ignores blank/garbage lines", () => {
    expect(parseNvidiaSmi("\n  \nbadline\n")).toEqual([]);
  });
});

describe("parseRocmSmi", () => {
  test("parses VRAM bytes -> MiB", () => {
    const json = JSON.stringify({ card0: { "VRAM Total Memory (B)": String(16 * 1024 * 1024 * 1024), "Card Series": "Radeon RX 7900 XTX" } });
    const out = parseRocmSmi(json);
    expect(out[0]?.vendor).toBe("amd");
    expect(out[0]?.vramMb).toBe(16384);
  });
  test("invalid json -> []", () => {
    expect(parseRocmSmi("not json")).toEqual([]);
  });
});
