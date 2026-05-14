import { defineCommand } from "citty";
import { createState, validateProposedState } from "@openpalm/lib";

export default defineCommand({
  meta: {
    name: "validate",
    description: "Validate environment configuration (key presence + non-empty required slots)",
  },
  async run() {
    // Use createState() directly — validateProposedState only needs vaultDir,
    // not the resolved compose artifacts ensureValidState() would pull in.
    const state = createState();
    const result = await validateProposedState(state);

    for (const warning of result.warnings) {
      console.warn(warning);
    }
    for (const err of result.errors) {
      console.error(err);
    }

    if (result.ok) {
      console.log("Configuration OK.");
      process.exit(0);
    }
    process.exit(1);
  },
});
