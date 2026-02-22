import coreYaml from "./core-automations.yaml" with { type: "text" };
import { parse } from "yaml";
import type { StackAutomation } from "../../admin/stack-spec.ts";

export const CORE_AUTOMATIONS: StackAutomation[] = parse(coreYaml);
