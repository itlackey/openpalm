---
schedule: "0 3 * * 0"
enabled: true
description: Download latest assets, pull images, and restart services weekly
tags: [openpalm, maintenance]
timeoutMs: 300000
command: ["sh","-c","curl -fsS -X POST 'http://admin:8100/admin/upgrade' -H \"x-admin-token: ${OP_ASSISTANT_TOKEN}\""]
---
