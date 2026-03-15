import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export default tool({
  description:
    "Validate the current stack configuration. Returns errors and warnings about missing files, invalid settings, or configuration drift. Use this before applying changes or when troubleshooting startup failures.",
  async execute() {
    return adminFetch("/admin/config/validate");
  },
});
