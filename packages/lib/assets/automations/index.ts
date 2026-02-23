import coreYaml from "./core-automations.yaml" with { type: "text" };
import type { StackAutomation } from "../../src/admin/stack-spec.ts";

export const CORE_AUTOMATIONS: StackAutomation[] = Bun.YAML.parse(coreYaml) as StackAutomation[];
