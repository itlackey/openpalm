# Contributing Snippets

Community snippets let anyone share reusable channel, service, and automation
configurations for OpenPalm. Each snippet is a single YAML file that uses the
same schema as the stack-spec — no conversion needed.

## Quick Start

1. Fork this repo
2. Create a YAML file in the appropriate directory:
   - `community/snippets/channels/` — for channel adapters
   - `community/snippets/services/` — for services
   - `community/snippets/automations/` — for scheduled automations
3. Follow the schema (see `snippet-schema.json` or use the YAML language server directive)
4. Open a pull request

## Snippet Format

Every snippet file must include:

```yaml
# yaml-language-server: $schema=../snippet-schema.json
kind: channel          # channel | service | automation
name: My Channel
description: One or two sentences describing what this does
image: myuser/my-channel:latest
containerPort: 8200
rewritePath: /my-channel/webhook
sharedSecretEnv: CHANNEL_MY_SECRET

env:
  - name: MY_API_KEY
    description: Your API key from the provider dashboard
    required: true
  - name: CHANNEL_MY_SECRET
    description: HMAC signing key. Auto-generated if left blank.
    required: false
```

All env vars are treated as strings. Values referencing secrets use the
`${SECRET_NAME}` syntax. The UI masks fields whose name contains SECRET,
TOKEN, KEY, or PASSWORD automatically.

## Self-Hosted Snippets (GitHub Topic Discovery)

You can also host snippets in your own repo without submitting a PR:

1. Create a repo with your snippet YAML files
2. Add an `openpalm-snippet.yaml` at the repo root
3. Tag your repo with the appropriate GitHub topic:
   - `openpalm-channel` — for channel snippets
   - `openpalm-service` — for service snippets
   - `openpalm-automation` — for automation snippets
4. OpenPalm instances with community discovery enabled will find your repo

Note: Self-hosted snippets appear with a "Community" trust badge in the UI,
while PR-submitted snippets in this repo get a "Curated" badge.

## Validation

CI automatically validates your snippet against `snippet-schema.json` on every
PR. You can also validate locally with any JSON Schema validator:

```bash
# Using ajv-cli
npx ajv-cli validate -s community/snippets/snippet-schema.json -d your-snippet.yaml
```

Or add the YAML language server directive to get real-time validation in VS Code:

```yaml
# yaml-language-server: $schema=../snippet-schema.json
```

## Checklist

Before submitting your PR, verify:

- [ ] YAML file is valid and in the correct subdirectory
- [ ] `name` is unique (no conflict with existing snippets)
- [ ] `description` is clear
- [ ] All `env` entries have `name` and `required`
- [ ] You have tested the container image locally
