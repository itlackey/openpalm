# Contributing Snippets

Community snippets let anyone share reusable channel, service, and automation
configurations for OpenPalm. Each snippet is a single YAML file that describes
what environment variables a container needs, their types, and how the UI should
render them.

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
apiVersion: v1
kind: channel          # channel | service | automation

metadata:
  id: my-unique-id     # kebab-case, globally unique
  name: My Snippet
  description: At least 10 characters describing what it does
  author: your-github-handle
  version: 1.0.0
  tags: [channel, my-platform]

env:
  - name: MY_API_KEY
    label: API Key
    description: Your API key from the provider dashboard
    type: secret       # text | secret | number | boolean | select | url | email
    required: true
```

For channels and services, add a `container` block:

```yaml
container:
  image: myuser/my-channel:latest
  port: 8200
  rewritePath: /my-channel/webhook
  sharedSecretEnv: CHANNEL_MY_SECRET
```

For automations, add an `automation` block:

```yaml
automation:
  schedule: "0 8 * * *"
  script: |
    #!/usr/bin/env bash
    set -euo pipefail
    curl -X POST http://gateway:8080/api/message ...
```

## Field Types

| Type | Renders As | Notes |
|------|-----------|-------|
| `text` | Text input | Plain string |
| `secret` | Password input | Never displayed in logs |
| `number` | Number input | Supports `min`/`max` |
| `boolean` | Checkbox | |
| `select` | Dropdown | Requires `options` array |
| `url` | URL input | Format validation |
| `email` | Email input | Format validation |

## Self-Hosted Snippets (GitHub Topic Discovery)

You can also host snippets in your own repo without submitting a PR:

1. Create a repo with your snippet YAML files
2. Add an `openpalm-snippet.yaml` at the repo root (or multiple files)
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
- [ ] `metadata.id` is unique (no conflict with existing snippets)
- [ ] `metadata.description` is clear (10-500 characters)
- [ ] All `env` entries have `name`, `label`, `type`, and `required`
- [ ] `select` type fields include `options`
- [ ] You have tested the container image locally
- [ ] `security` block honestly describes capabilities (if applicable)
