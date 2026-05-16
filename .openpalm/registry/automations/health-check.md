---
schedule: "*/5 * * * *"
enabled: true
description: Monitor that all services are running
tags: [openpalm, health]
timeoutMs: 10000
command: ["sh","-c","curl -fsS -X GET 'http://admin:8100/health' -H \"x-admin-token: ${OP_ASSISTANT_TOKEN}\""]
---
