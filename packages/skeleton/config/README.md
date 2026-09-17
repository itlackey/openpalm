# Operator configuration

Files under `config/` are operator-owned. Install and update seed a missing
default but never replace an existing file.

| Directory | Purpose |
|---|---|
| `assistant/` | Trusted local OpenCode preferences |
| `guardian/` | Guardian moderator model/provider preferences |
| `akm/` | AKM configuration |
| `stack/` | The sole user Compose overlay |

Credentials do not belong here. Delegated runtime credentials live in
`state/secrets/`; provider auth lives in `knowledge/secrets/auth.json`.
