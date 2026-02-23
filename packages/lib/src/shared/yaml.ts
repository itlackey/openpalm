import YAML from "yaml";

type BunYaml = {
  parse?: (input: string) => unknown;
  stringify?: (input: unknown, replacer?: unknown, space?: number) => string;
};

function bunYaml(): BunYaml | undefined {
  const candidate = (globalThis as { Bun?: { YAML?: BunYaml } }).Bun;
  return candidate?.YAML;
}

export function parseYamlDocument(content: string): unknown {
  const parser = bunYaml()?.parse;
  if (parser) return parser(content);
  return YAML.parse(content) as unknown;
}

export function stringifyYamlDocument(value: unknown): string {
  const stringify = bunYaml()?.stringify;
  if (stringify) return stringify(value, null, 2);
  return YAML.stringify(value, { indent: 2 });
}
