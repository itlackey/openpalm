import { test, expect, describe } from "bun:test";
import {
  recommendSetup,
  gpuToProfileVariant,
  MIN_LOCAL_GPU_VRAM_MB,
  type SetupRecommendationInput,
} from "./setup-recommendation.js";
import { parseNvidiaSmi, parseRocmSmi, parseAppleSilicon, type GpuInfo } from "./hardware-detect.js";

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

  test("darwin + apple GPU + no provider -> connect-manually (NOT enable-ollama), Mac-tailored alert", () => {
    const r = recommendSetup({ ...base, platform: "darwin", gpu: gpu("apple", 65536, "Apple Silicon (Mac15,7)") });
    expect(r.action).toBe("connect-manually");
    expect(r.action).not.toBe("enable-ollama");
    if (r.action === "connect-manually") {
      expect(r.alert).toContain("macOS");
      expect(r.alert).toContain("Metal");
      expect(r.alert.toLowerCase()).toContain("ollama");
    }
  });

  test("darwin + apple GPU never selects cuda/rocm (no in-stack enable)", () => {
    // Even with huge unified memory, darwin+apple must not enable in-stack ollama.
    const r = recommendSetup({ ...base, platform: "darwin", gpu: gpu("apple", 131072) });
    expect(r.action).not.toBe("enable-ollama");
  });

  test("darwin + host ollama running -> still use-host-providers (wins over apple guidance)", () => {
    const r = recommendSetup({
      ...base,
      platform: "darwin",
      hostProviders: [{ provider: "ollama", url: "http://localhost:11434" }],
      gpu: gpu("apple", 65536),
    });
    expect(r.action).toBe("use-host-providers");
  });

  test("linux + nvidia >= threshold -> still enable-ollama cuda (unchanged)", () => {
    const r = recommendSetup({ ...base, platform: "linux", gpu: gpu("nvidia", 24576) });
    expect(r.action).toBe("enable-ollama");
    if (r.action === "enable-ollama") expect(r.profileVariant).toBe("cuda");
  });

  test("no cloud, no host, no GPU -> connect-manually", () => {
    const r = recommendSetup(base);
    expect(r.action).toBe("connect-manually");
    if (r.action === "connect-manually") expect(r.alert).toContain("custom OpenAI-compatible");
  });
});

describe("hostCredentialCount precedence", () => {
  test("(a) host-configured + capable GPU + no cloud -> NOT enable-ollama (host wins)", () => {
    const r = recommendSetup({
      cloudProviders: [],
      hostProviders: [],
      gpu: gpu("nvidia", 24576),
      hostCredentialCount: 2,
    });
    expect(r.action).not.toBe("enable-ollama");
    expect(r.action).toBe("connect-manually");
    if (r.action === "connect-manually") {
      expect(r.alert).toContain("host OpenCode");
      expect(r.alert).toContain("Import");
    }
  });

  test("(b) cloud still wins over host-configured", () => {
    const r = recommendSetup({
      cloudProviders: ["openai"],
      hostProviders: [],
      gpu: null,
      hostCredentialCount: 3,
    });
    expect(r.action).toBe("use-cloud");
  });

  test("(c) host-configured beats a running host Ollama (import hint over auto-add)", () => {
    // When the user has both a running host Ollama AND host OpenCode credentials,
    // the richer "import your existing setup" guidance wins over the auto-add path.
    const r = recommendSetup({
      cloudProviders: [],
      hostProviders: [{ provider: "ollama", url: "http://localhost:11434" }],
      gpu: null,
      hostCredentialCount: 1,
    });
    expect(r.action).toBe("connect-manually");
    expect(r.action).not.toBe("use-host-providers");
    if (r.action === "connect-manually") expect(r.alert).toContain("host OpenCode");
  });

  test("host-configured with zero credentials -> falls through to normal rules", () => {
    // hostCredentialCount: 0 (or absent) must not suppress the normal GPU path.
    const r = recommendSetup({ ...base, gpu: gpu("nvidia", 24576), hostCredentialCount: 0 });
    expect(r.action).toBe("enable-ollama");
  });

  test("host-configured omitted (undefined) -> falls through to normal rules", () => {
    // No regression: callers that don't pass hostCredentialCount get the old behaviour.
    const r = recommendSetup({ ...base, gpu: gpu("nvidia", 24576) });
    expect(r.action).toBe("enable-ollama");
  });

  test("host-configured + no GPU + no cloud -> connect-manually with import alert", () => {
    const r = recommendSetup({ ...base, hostCredentialCount: 1 });
    expect(r.action).toBe("connect-manually");
    if (r.action === "connect-manually") expect(r.alert).toContain("host OpenCode");
  });

  test("host-configured + darwin apple GPU -> connect-manually (host wins, not apple guidance)", () => {
    // Both host-configured and darwin+apple would return connect-manually, but
    // host-configured takes priority so the alert is the import one, not the Metal one.
    const r = recommendSetup({
      ...base,
      platform: "darwin",
      gpu: gpu("apple", 65536),
      hostCredentialCount: 2,
    });
    expect(r.action).toBe("connect-manually");
    if (r.action === "connect-manually") {
      expect(r.alert).toContain("host OpenCode");
      expect(r.alert).not.toContain("Metal");
    }
  });
});

describe("gpuToProfileVariant", () => {
  test("nvidia->cuda, amd->rocm, apple->cpu, unknown->cpu", () => {
    expect(gpuToProfileVariant(gpu("nvidia", 8192))).toBe("cuda");
    expect(gpuToProfileVariant(gpu("amd", 8192))).toBe("rocm");
    expect(gpuToProfileVariant(gpu("apple", 65536))).toBe("cpu");
    expect(gpuToProfileVariant(gpu("unknown", 8192))).toBe("cpu");
  });
});

describe("parseAppleSilicon", () => {
  test("parses hw.memsize bytes -> MiB + vendor apple + model name", () => {
    const stdout = `${16 * 1024 * 1024 * 1024}\nMac15,7\n`;
    const out = parseAppleSilicon(stdout);
    expect(out).toEqual([{ vendor: "apple", name: "Apple Silicon (Mac15,7)", vramMb: 16384 }]);
  });
  test("missing model line -> falls back to arm64", () => {
    const out = parseAppleSilicon(`${8 * 1024 * 1024 * 1024}\n`);
    expect(out[0]?.vendor).toBe("apple");
    expect(out[0]?.name).toBe("Apple Silicon (arm64)");
    expect(out[0]?.vramMb).toBe(8192);
  });
  test("garbage / empty -> []", () => {
    expect(parseAppleSilicon("")).toEqual([]);
    expect(parseAppleSilicon("not-a-number\nMac15,7")).toEqual([]);
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
