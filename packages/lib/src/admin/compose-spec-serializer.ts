import YAML from "yaml";
import type { ComposeSpec } from "./compose-spec.ts";

export function stringifyComposeSpec(spec: ComposeSpec): string {
  return YAML.stringify(spec, { indent: 2, sortMapEntries: true });
}
