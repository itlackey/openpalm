import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

interface AuditEntry {
  timestamp?: string;
  requestId?: string;
  request_id?: string;
  [key: string]: unknown;
}

export default tool({
  description:
    "Trace a request through the OpenPalm pipeline by its request ID. Searches both guardian and admin audit logs to show how the request flowed through the system, ordered by timestamp. Use this to debug message delivery issues or understand request processing.",
  args: {
    requestId: tool.schema
      .string()
      .describe("The request ID to trace (from logs or audit entries)"),
  },
  async execute(args) {
    if (!args.requestId.trim()) {
      return JSON.stringify({ error: true, message: "requestId must not be empty" });
    }

    const [guardianRaw, adminRaw] = await Promise.all([
      adminFetch("/admin/audit?source=guardian&limit=500"),
      adminFetch("/admin/audit?limit=500"),
    ]);

    let guardianEntries: AuditEntry[] = [];
    let adminEntries: AuditEntry[] = [];

    try {
      const parsed = JSON.parse(guardianRaw);
      guardianEntries = Array.isArray(parsed) ? parsed : parsed.entries || [];
    } catch {
      // ignore parse errors
    }

    try {
      const parsed = JSON.parse(adminRaw);
      adminEntries = Array.isArray(parsed) ? parsed : parsed.entries || [];
    } catch {
      // ignore parse errors
    }

    const rid = args.requestId.trim();

    const matchingGuardian = guardianEntries
      .filter((e) => (e.requestId || e.request_id) === rid)
      .map((e) => ({ ...e, _source: "guardian" }));

    const matchingAdmin = adminEntries
      .filter((e) => (e.requestId || e.request_id) === rid)
      .map((e) => ({ ...e, _source: "admin" }));

    const timeline = [...matchingGuardian, ...matchingAdmin].sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return ta - tb;
    });

    if (timeline.length === 0) {
      return JSON.stringify({
        requestId: rid,
        found: false,
        message: `No audit entries found for request ID '${rid}'. The request may be older than the audit log window, or the ID may be incorrect.`,
      });
    }

    return JSON.stringify(
      {
        requestId: rid,
        found: true,
        entryCount: timeline.length,
        timeline,
      },
      null,
      2
    );
  },
});
