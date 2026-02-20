import { describe, expect, it, afterEach } from "bun:test";
import {
  detectAnthropicKey,
  detectOpenAIKey,
  getSmallModelCandidates,
  writeProviderSeedFile,
  detectAllProviders,
  findExistingOpenCodeConfig,
} from "@openpalm/lib/detect-providers.ts";
import type { DetectedProvider } from "../src/types.ts";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("detect-providers", () => {
  describe("detectAnthropicKey", () => {
    it("returns provider with apiKeyPresent: false when env not set", () => {
      // Save original value
      const originalKey = Bun.env.ANTHROPIC_API_KEY;

      // Temporarily unset the key
      delete Bun.env.ANTHROPIC_API_KEY;

      try {
        const provider = detectAnthropicKey();
        expect(provider.name).toBe("Anthropic");
        expect(provider.type).toBe("api");
        expect(provider.apiKeyPresent).toBe(false);
        expect(provider.models).toEqual([]);
      } finally {
        // Restore original value
        if (originalKey !== undefined) {
          Bun.env.ANTHROPIC_API_KEY = originalKey;
        }
      }
    });

    it("returns provider with apiKeyPresent: true when key present", () => {
      // Save original value
      const originalKey = Bun.env.ANTHROPIC_API_KEY;

      try {
        Bun.env.ANTHROPIC_API_KEY = "test-key-123";
        const provider = detectAnthropicKey();
        expect(provider.apiKeyPresent).toBe(true);
        expect(provider.models.length).toBe(2);
        expect(provider.models[0].id).toBe("anthropic/claude-sonnet-4-5");
        expect(provider.models[1].id).toBe("anthropic/claude-haiku-4-5");
      } finally {
        // Restore original value
        if (originalKey !== undefined) {
          Bun.env.ANTHROPIC_API_KEY = originalKey;
        } else {
          delete Bun.env.ANTHROPIC_API_KEY;
        }
      }
    });
  });

  describe("detectOpenAIKey", () => {
    it("returns provider with apiKeyPresent: false when env not set", () => {
      // Save original value
      const originalKey = Bun.env.OPENAI_API_KEY;

      // Temporarily unset the key
      delete Bun.env.OPENAI_API_KEY;

      try {
        const provider = detectOpenAIKey();
        expect(provider.name).toBe("OpenAI");
        expect(provider.type).toBe("api");
        expect(provider.apiKeyPresent).toBe(false);
        expect(provider.models).toEqual([]);
      } finally {
        // Restore original value
        if (originalKey !== undefined) {
          Bun.env.OPENAI_API_KEY = originalKey;
        }
      }
    });

    it("returns provider with apiKeyPresent: true when key present", () => {
      // Save original value
      const originalKey = Bun.env.OPENAI_API_KEY;

      try {
        Bun.env.OPENAI_API_KEY = "test-key-456";
        const provider = detectOpenAIKey();
        expect(provider.apiKeyPresent).toBe(true);
        expect(provider.models.length).toBe(2);
        expect(provider.models[0].id).toBe("openai/gpt-4o");
        expect(provider.models[1].id).toBe("openai/gpt-4o-mini");
      } finally {
        // Restore original value
        if (originalKey !== undefined) {
          Bun.env.OPENAI_API_KEY = originalKey;
        } else {
          delete Bun.env.OPENAI_API_KEY;
        }
      }
    });
  });

  describe("getSmallModelCandidates", () => {
    it("returns only small models from providers with keys", () => {
      const providers: DetectedProvider[] = [
        {
          name: "Anthropic",
          type: "api",
          apiKeyPresent: true,
          models: [
            {
              id: "anthropic/claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              provider: "anthropic",
              isSmall: false,
            },
            {
              id: "anthropic/claude-haiku-4-5",
              name: "Claude Haiku 4.5",
              provider: "anthropic",
              isSmall: true,
            },
          ],
        },
        {
          name: "OpenAI",
          type: "api",
          apiKeyPresent: false,
          models: [
            {
              id: "openai/gpt-4o-mini",
              name: "GPT-4o Mini",
              provider: "openai",
              isSmall: true,
            },
          ],
        },
      ];

      const candidates = getSmallModelCandidates(providers);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe("anthropic/claude-haiku-4-5");
    });

    it("returns local provider models regardless of key", () => {
      const providers: DetectedProvider[] = [
        {
          name: "Ollama",
          type: "local",
          baseUrl: "http://localhost:11434",
          apiKeyPresent: true,
          models: [
            {
              id: "llama3.2:3b",
              name: "llama3.2:3b",
              provider: "ollama",
              isSmall: true,
            },
          ],
        },
      ];

      const candidates = getSmallModelCandidates(providers);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe("llama3.2:3b");
    });

    it("returns empty array when no small models available", () => {
      const providers: DetectedProvider[] = [
        {
          name: "Anthropic",
          type: "api",
          apiKeyPresent: true,
          models: [
            {
              id: "anthropic/claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              provider: "anthropic",
              isSmall: false,
            },
          ],
        },
      ];

      const candidates = getSmallModelCandidates(providers);
      expect(candidates).toHaveLength(0);
    });
  });

  describe("writeProviderSeedFile", () => {
    it("writes valid JSON", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openpalm-test-"));
      const outputPath = join(tempDir, "providers.json");

      try {
        const providers: DetectedProvider[] = [
          {
            name: "Anthropic",
            type: "api",
            apiKeyPresent: true,
            models: [
              {
                id: "anthropic/claude-haiku-4-5",
                name: "Claude Haiku 4.5",
                provider: "anthropic",
                isSmall: true,
              },
            ],
          },
        ];

        await writeProviderSeedFile(providers, outputPath);

        const content = await readFile(outputPath, "utf-8");
        const parsed = JSON.parse(content);

        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].name).toBe("Anthropic");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("detectAllProviders", () => {
    it("returns an array of DetectedProvider objects", async () => {
      const result = await detectAllProviders();
      expect(Array.isArray(result.providers)).toBe(true);
      expect(result.providers.length).toBeGreaterThanOrEqual(2);

      // Verify each provider has required properties
      for (const provider of result.providers) {
        expect(provider).toHaveProperty("name");
        expect(provider).toHaveProperty("type");
        expect(provider).toHaveProperty("apiKeyPresent");
        expect(provider).toHaveProperty("models");
      }
    });
  });

  describe("findExistingOpenCodeConfig", () => {
    it("returns either null or a string", async () => {
      const result = await findExistingOpenCodeConfig();
      expect(result === null || typeof result === "string").toBe(true);
    });
  });
});
