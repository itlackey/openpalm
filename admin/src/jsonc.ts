export function parseJsonc(input: string): unknown {
  const stripped = input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped);
}

export function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n";
}
