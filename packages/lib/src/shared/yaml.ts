import YAML from "yaml";

export function parseYamlDocument(content: string): unknown {
  const parser = (Bun as unknown as { YAML?: { parse?: (input: string) => unknown } }).YAML?.parse;
  if (parser) return parser(content);
  return YAML.parse(content) as unknown;
}

export function stringifyYamlDocument(value: unknown): string {
  const stringify = (Bun as unknown as { YAML?: { stringify?: (input: unknown, replacer?: unknown, space?: number) => string } }).YAML?.stringify;
  if (stringify) return stringify(value, null, 2);
  return YAML.stringify(value, { indent: 2 });
}
