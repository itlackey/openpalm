export async function readEnvFile(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return {};
  }

  const content = await file.text();
  const lines = content.split("\n");
  const env: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and blank lines
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    // Split on first = only
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();
    env[key] = value;
  }

  return env;
}

export async function readEnvVar(path: string, key: string): Promise<string | undefined> {
  const env = await readEnvFile(path);
  return env[key];
}

export async function upsertEnvVar(path: string, key: string, value: string): Promise<void> {
  const file = Bun.file(path);
  const exists = await file.exists();

  if (!exists) {
    // Create new file with the key-value pair
    await Bun.write(path, `${key}=${value}\n`);
    return;
  }

  const content = await file.text();
  const lines = content.split("\n");
  let found = false;
  const newLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Check if this line starts with our key
    if (trimmed.startsWith(`${key}=`)) {
      newLines.push(`${key}=${value}`);
      found = true;
    } else {
      newLines.push(line);
    }
  }

  if (!found) {
    // Append the new key-value pair
    // Remove trailing empty line if present to avoid double newlines
    while (newLines.length > 0 && newLines[newLines.length - 1].trim() === "") {
      newLines.pop();
    }
    newLines.push(`${key}=${value}`);
    newLines.push(""); // Add trailing newline
  }

  await Bun.write(path, newLines.join("\n"));
}

/**
 * Upserts multiple key-value pairs into an env file in a single read-write cycle.
 * Prefer this over calling `upsertEnvVar` repeatedly when writing several keys
 * to the same file, as it avoids N redundant read-write operations.
 */
export async function upsertEnvVars(filePath: string, entries: [key: string, value: string][]): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    const content = entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    await Bun.write(filePath, content);
    return;
  }

  const content = await file.text();
  const lines = content.split("\n");

  // Track which keys have already been updated in-place
  const updated = new Set<string>();
  const newLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Check if this line matches any of the incoming keys
    const match = entries.find(([k]) => trimmed.startsWith(`${k}=`));
    if (match) {
      const [k, v] = match;
      newLines.push(`${k}=${v}`);
      updated.add(k);
    } else {
      newLines.push(line);
    }
  }

  // Append keys that were not found in the existing file
  const toAppend = entries.filter(([k]) => !updated.has(k));
  if (toAppend.length > 0) {
    // Remove trailing empty lines to avoid double newlines
    while (newLines.length > 0 && newLines[newLines.length - 1].trim() === "") {
      newLines.pop();
    }
    for (const [k, v] of toAppend) {
      newLines.push(`${k}=${v}`);
    }
    newLines.push(""); // Restore trailing newline
  }

  await Bun.write(filePath, newLines.join("\n"));
}

export async function generateEnvFromTemplate(
  templatePath: string,
  outputPath: string,
  overrides: Record<string, string>
): Promise<void> {
  // Copy template to output
  const template = Bun.file(templatePath);
  const templateContent = await template.text();
  await Bun.write(outputPath, templateContent);

  // Apply all overrides in a single read-write cycle
  await upsertEnvVars(outputPath, Object.entries(overrides));
}
