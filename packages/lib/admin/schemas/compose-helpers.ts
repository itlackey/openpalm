/**
 * Substitutes Docker Compose variable references with placeholder values
 * so the YAML can be parsed and structurally validated.
 */
export function substituteComposeVariables(yaml: string): string {
  return yaml
    .replace(/\$\{([A-Z_][A-Z0-9_]*):-([^}]*)}/g, (_m, _v, def) => def)
    .replace(/\$\{([A-Z_][A-Z0-9_]*)}/g, "placeholder")
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, "placeholder");
}
