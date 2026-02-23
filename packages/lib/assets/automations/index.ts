import coreYaml from "./core-automations.yaml" with { type: "text" };
import type { StackAutomation } from "../../src/admin/stack-spec.ts";
import { parseYamlDocument } from "../../src/shared/yaml.ts";

export const CORE_AUTOMATIONS: StackAutomation[] = parseYamlDocument(coreYaml) as StackAutomation[];
