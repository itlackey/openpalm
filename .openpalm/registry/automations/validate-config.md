---
schedule: "0 3 * * *"
enabled: true
description: Periodic check of environment configuration against the schema
tags: [openpalm, maintenance]
timeoutMs: 15000
command: ["sh","-c","curl -fsS -X GET 'http://admin:8100/admin/config/validate' -H \"x-admin-token: ${OP_ASSISTANT_TOKEN}\""]
---
