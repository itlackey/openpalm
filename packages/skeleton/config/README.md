# Operator configuration

Files under `config/` are operator-owned. Install and update seed a missing
default but never replace an existing file.

| Directory | Purpose |
|---|---|
| `assistant/` | Trusted local OpenCode preferences |
| `guardian/` | Guardian moderator model/provider preferences |
| `akm/` | AKM configuration |
| `portal/discord/` | Discord user-to-credential map |
| `portal/slack/` | Slack user-to-credential map |
| `stack/` | The sole user Compose overlay |

The portal maps contain platform IDs and credential usernames, never keys.
Named bearer keys live in `state/credentials/`, other delegated runtime
credentials live in `state/secrets/`, and provider auth lives in
`knowledge/secrets/auth.json`.
