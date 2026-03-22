/** Env schema parser — extracted to break circular imports. */
import { existsSync, readFileSync } from "node:fs";

export type EnvSchemaField = {
  name: string;
  defaultValue: string;
  required: boolean;
  sensitive: boolean;
  helpText: string;
  section: string;
};

export function parseEnvSchema(schemaPath: string): EnvSchemaField[] {
  if (!existsSync(schemaPath)) return [];

  const content = readFileSync(schemaPath, "utf-8");
  const lines = content.split("\n");
  const fields: EnvSchemaField[] = [];

  let currentSection = "";
  let pendingComments: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Section separator: # ---
    if (/^#\s*---\s*$/.test(trimmed)) {
      // The last non-empty comment before this separator is the section header
      const lastComment = pendingComments.filter((c) => c.length > 0).pop();
      if (lastComment) {
        currentSection = lastComment;
      }
      pendingComments = [];
      continue;
    }

    // Comment line
    if (trimmed.startsWith("#")) {
      const commentText = trimmed.replace(/^#\s*/, "");
      pendingComments.push(commentText);
      continue;
    }

    // Empty line — reset pending comments only if we haven't hit a field
    if (!trimmed) {
      pendingComments = [];
      continue;
    }

    // Field definition: KEY=VALUE
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;

    const name = trimmed.slice(0, eqIdx).trim();
    const defaultValue = trimmed.slice(eqIdx + 1).trim();

    // Parse annotations from pending comments
    let required = false;
    let sensitive = false;
    const helpLines: string[] = [];

    for (const comment of pendingComments) {
      if (/@required(?:\s*=\s*false)?/.test(comment) && !/@required\s*=\s*false/.test(comment)) {
        required = true;
      }
      if (/@sensitive(?:\s*=\s*false)?/.test(comment) && !/@sensitive\s*=\s*false/.test(comment)) {
        sensitive = true;
      }
      // Help text is any comment that isn't purely an annotation
      const stripped = comment.replace(/@required/g, "").replace(/@sensitive/g, "").trim();
      if (stripped) {
        helpLines.push(stripped);
      }
    }

    fields.push({
      name,
      defaultValue,
      required,
      sensitive,
      helpText: helpLines.join(" "),
      section: currentSection,
    });

    pendingComments = [];
  }

  return fields;
}
