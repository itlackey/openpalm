# OpenPalm Skeleton

Skeleton contains files selectively copied into `OP_HOME`.

Managed files are overwritten whole:

- `system/stack/stack.compose.yml`
- `system/assistant/.gitignore`
- `system/assistant/opencode.jsonc`
- `system/assistant/AGENTS.md`
- `system/assistant/agents/remote.md`
- `system/assistant/agents/remote-read.md`
- `system/assistant/agents/remote-full.md`
- `system/assistant/agents/scheduled.md`
- `system/assistant/plugins/akm.js`
- `system/guardian/.gitignore`
- `system/guardian/opencode.jsonc`
- `system/guardian/instructions/moderation.md`

Operator files are seeded only when absent:

- `config/stack/custom.compose.yml`
- `config/assistant/.gitignore`
- `config/assistant/opencode.json`
- `config/assistant/persona.md`
- `config/assistant/user-profile.md`
- `config/akm/config.json`
- `config/guardian/.gitignore`
- `config/guardian/opencode.json`
- `config/guardian/oauth.json`
- `config/guardian/oauth-identities.json`
- `config/portal/discord/credentials.json`
- `config/portal/slack/credentials.json`
- `knowledge/env/user.env`

The allowlists live in `packages/lib/src/control-plane/lean-seed.ts` and the
compiled CLI archive packer. Adding a file to this directory does not activate
it. Legacy files remain present only until their exact deletion paths are
approved.

Fresh 0.14 homes seed no task definitions. Users create recurring work through
the agent's natural-language schedule flow; task files imported from an older
home remain disabled until reviewed.
