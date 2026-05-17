---
schedule: "*/5 * * * *"
enabled: true
description: Monitor that all services are running
tags: [openpalm, health]
timeoutMs: 10000
type: assistant
command: ["sh","-c","openpalm status --json"]
---
