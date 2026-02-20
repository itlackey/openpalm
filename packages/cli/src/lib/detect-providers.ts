import { homedir } from "node:os";
import type { DetectedProvider, DetectedModel } from "../types.ts";

export const OLLAMA_URL = "http://localhost:11434";
export const LM_STUDIO_URL = "http://localhost:1234";
export const SMALL_MODEL_PATTERNS = [
  /3b/i,
  /7b/i,
  /mini/i,
  /small/i,
  /haiku/i,
  /flash/i,
  /nano/i,
];

export async function probeOllama(): Promise<DetectedProvider | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      models: Array<{ name: string }>;
    };

    const models: DetectedModel[] = data.models.map((model) => {
      const isSmall = SMALL_MODEL_PATTERNS.some((pattern) =>
        pattern.test(model.name)
      );

      return {
        id: model.name,
        name: model.name,
        provider: "ollama",
        isSmall,
      };
    });

    return {
      name: "Ollama",
      type: "local",
      baseUrl: OLLAMA_URL,
      apiKeyPresent: true,
      models,
    };
  } catch {
    return null;
  }
}

export async function probeLMStudio(): Promise<DetectedProvider | null> {
  try {
    const response = await fetch(`${LM_STUDIO_URL}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      data: Array<{ id: string }>;
    };

    const models: DetectedModel[] = data.data.map((model) => {
      const isSmall = SMALL_MODEL_PATTERNS.some((pattern) =>
        pattern.test(model.id)
      );

      return {
        id: model.id,
        name: model.id,
        provider: "lmstudio",
        isSmall,
      };
    });

    return {
      name: "LM Studio",
      type: "local",
      baseUrl: LM_STUDIO_URL,
      apiKeyPresent: true,
      models,
    };
  } catch {
    return null;
  }
}

export function detectAnthropicKey(): DetectedProvider {
  const apiKey = Bun.env.ANTHROPIC_API_KEY;
  const apiKeyPresent = !!apiKey && apiKey.length > 0;

  const models: DetectedModel[] = apiKeyPresent
    ? [
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
      ]
    : [];

  return {
    name: "Anthropic",
    type: "api",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    apiKeyPresent,
    models,
  };
}

export function detectOpenAIKey(): DetectedProvider {
  const apiKey = Bun.env.OPENAI_API_KEY;
  const apiKeyPresent = !!apiKey && apiKey.length > 0;

  const models: DetectedModel[] = apiKeyPresent
    ? [
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          provider: "openai",
          isSmall: false,
        },
        {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o Mini",
          provider: "openai",
          isSmall: true,
        },
      ]
    : [];

  return {
    name: "OpenAI",
    type: "api",
    apiKeyEnvVar: "OPENAI_API_KEY",
    apiKeyPresent,
    models,
  };
}

export async function findExistingOpenCodeConfig(): Promise<string | null> {
  const home = homedir();
  const paths = [
    `${home}/.config/opencode/opencode.jsonc`,
    `${home}/.opencode/opencode.jsonc`,
    "./opencode.jsonc",
  ];

  for (const path of paths) {
    const file = Bun.file(path);
    if (await file.exists()) {
      return path;
    }
  }

  return null;
}

export async function detectAllProviders(): Promise<{
  providers: DetectedProvider[];
  existingConfigPath: string | null;
}> {
  const [ollama, lmStudio, existingConfigPath] = await Promise.all([
    probeOllama(),
    probeLMStudio(),
    findExistingOpenCodeConfig(),
  ]);

  const anthropic = detectAnthropicKey();
  const openai = detectOpenAIKey();

  const providers: DetectedProvider[] = [];

  if (ollama) providers.push(ollama);
  if (lmStudio) providers.push(lmStudio);
  if (anthropic) providers.push(anthropic);
  if (openai) providers.push(openai);

  return {
    providers,
    existingConfigPath,
  };
}

export function getSmallModelCandidates(
  providers: DetectedProvider[]
): DetectedModel[] {
  return providers
    .filter(
      (provider) => provider.apiKeyPresent || provider.type === "local"
    )
    .flatMap((provider) => provider.models)
    .filter((model) => model.isSmall);
}

export async function writeProviderSeedFile(
  providers: DetectedProvider[],
  outputPath: string
): Promise<void> {
  await Bun.write(outputPath, JSON.stringify(providers, null, 2));
}
