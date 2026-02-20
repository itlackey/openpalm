export function parseJsonc(input: string): unknown {
  // Strip block comments, then inline // comments (but not inside strings),
  // then trailing commas before } or ]
  let result = input.replace(/\/\*[\s\S]*?\*\//g, "");

  // Remove // comments that are NOT inside strings.
  // Walk character-by-character to track string context.
  let inString = false;
  let escape = false;
  let out = "";
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      out += ch;
      continue;
    }
    // Not in a string
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && result[i + 1] === "/") {
      // Skip to end of line
      const nl = result.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1; // loop will increment
      continue;
    }
    out += ch;
  }

  // Strip trailing commas: , followed by optional whitespace then } or ]
  const cleaned = out.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(cleaned);
}

export function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n";
}
