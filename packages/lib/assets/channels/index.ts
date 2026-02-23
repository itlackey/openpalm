import { parseYamlDocument } from "../../src/shared/yaml.ts";
import type { EnvVarDef } from "../../src/shared/snippet-types.ts";
import chatYaml from "./chat.yaml" with { type: "text" };
import discordYaml from "./discord.yaml" with { type: "text" };
import voiceYaml from "./voice.yaml" with { type: "text" };
import telegramYaml from "./telegram.yaml" with { type: "text" };
export type BuiltInChannelDef = {
  name: string;
  description: string;
  containerPort: number;
  rewritePath: string;
  sharedSecretEnv: string;
  configKeys: string[];
  env: EnvVarDef[];
};

function parseBuiltInChannel(raw: string, source: string): BuiltInChannelDef {
  const parsed = parseYamlDocument(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid channel YAML (${source}): expected an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string") throw new Error(`Channel YAML (${source}): missing 'name'`);
  if (typeof obj.containerPort !== "number") throw new Error(`Channel YAML (${source}): 'containerPort' must be a number`);
  if (typeof obj.rewritePath !== "string") throw new Error(`Channel YAML (${source}): missing 'rewritePath'`);
  if (typeof obj.sharedSecretEnv !== "string") throw new Error(`Channel YAML (${source}): missing 'sharedSecretEnv'`);
  if (!Array.isArray(obj.env)) throw new Error(`Channel YAML (${source}): 'env' must be an array`);
  const env = obj.env as EnvVarDef[];
  return {
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : "",
    containerPort: obj.containerPort,
    rewritePath: obj.rewritePath,
    sharedSecretEnv: obj.sharedSecretEnv,
    configKeys: env.map((e) => e.name),
    env,
  };
}

export const BUILTIN_CHANNELS: Record<string, BuiltInChannelDef> = Object.fromEntries(
  ([
    [chatYaml, "chat.yaml"],
    [discordYaml, "discord.yaml"],
    [voiceYaml, "voice.yaml"],
    [telegramYaml, "telegram.yaml"],
  ] as const).map(([raw, source]) => {
    const def = parseBuiltInChannel(raw, source);
    return [def.name.toLowerCase(), def];
  }),
);
