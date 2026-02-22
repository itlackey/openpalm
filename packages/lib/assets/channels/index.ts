import chatYaml from "./chat.yaml" with { type: "text" };
import discordYaml from "./discord.yaml" with { type: "text" };
import voiceYaml from "./voice.yaml" with { type: "text" };
import telegramYaml from "./telegram.yaml" with { type: "text" };
import { parse } from "yaml";

export type BuiltInChannelDef = {
  name: string;
  containerPort: number;
  rewritePath: string;
  sharedSecretEnv: string;
  configKeys: string[];
};

export const BUILTIN_CHANNELS: Record<string, BuiltInChannelDef> = Object.fromEntries(
  [chatYaml, discordYaml, voiceYaml, telegramYaml].map((raw) => {
    const def = parse(raw) as BuiltInChannelDef;
    return [def.name.toLowerCase(), def];
  }),
);
