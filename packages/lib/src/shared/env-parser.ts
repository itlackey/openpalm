type ParseEnvOptions = {
  stripQuotedValues?: boolean;
};

export function parseEnvLine(line: string, options: ParseEnvOptions = {}): [key: string, value: string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return null;

  const [rawKey, ...rest] = trimmed.split("=");
  const key = rawKey.trim();
  if (!key) return null;

  let value = rest.join("=").trim();
  if (options.stripQuotedValues) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
  }
  return [key, value];
}

export function parseEnvContent(content: string, options: ParseEnvOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line, options);
    if (!parsed) continue;
    out[parsed[0]] = parsed[1];
  }
  return out;
}
