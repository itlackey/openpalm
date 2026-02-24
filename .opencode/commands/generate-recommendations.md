---
description: "Analyze the codebase and generate a report with actionable recommendations"
---

Analyze the codebase based on the following request and generate a structured recommendations report. Research the relevant code, docs, tests, and configuration thoroughly before forming conclusions.

The report must be written to `.plans/recommendations.md` and must contain:

1. **Summary** — a brief overview of what was analyzed and the key findings
2. **Recommendations** — a numbered list of actionable recommendations, each with:
   - A short title
   - A clear description of the problem or opportunity
   - The proposed solution or change
   - References to specific files and line numbers

Once the report is written, output the full list of recommendation titles so it can be used as input for the `/create-task-list` command.

Request: $ARGUMENTS
