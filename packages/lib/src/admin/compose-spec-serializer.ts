import YAML from "yaml";
import type { ComposeSpec } from "./compose-spec.ts";

export function validateComposeSpec(spec: ComposeSpec): string[] {
  const errors: string[] = [];
  for (const [name, service] of Object.entries(spec.services)) {
    if (!service.restart) errors.push(`missing_restart:${name}`);
    if (!service.healthcheck) errors.push(`missing_healthcheck:${name}`);
  }
  return errors;
}

export function stringifyComposeSpec(spec: ComposeSpec): string {
  return YAML.stringify(spec, { indent: 2, sortMapEntries: true });
}
