# OpenPalm Extension Registry

This folder is the **public community registry** for OpenPalm extensions. Admins can search and install entries from this registry at runtime through the admin dashboard — no Docker image rebuild required.

## How it works

- Each extension is a single `.json` file in this folder
- `index.json` is auto-generated from all individual entries — **do not edit it manually**
- The admin dashboard fetches `index.json` from GitHub at runtime to show community extensions
- Adding or updating a registry entry never triggers a Docker image rebuild

## Submitting an extension

1. Fork the repository
2. Copy `example-plugin.json` to a new file named after your extension ID (e.g., `my-org-my-plugin.json`)
3. Fill in all required fields (see [Schema](#schema) below)
4. Open a pull request — maintainers will review and merge

> **Important:** Registry entries are community-submitted. Install only extensions you trust. Always review the `source` URL and `securityNotes` before installing.

## Schema

Each entry must be a valid JSON object matching this structure:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Unique identifier (e.g., `com.myorg.my-plugin`). Use reverse-domain or kebab-case. |
| `name` | string | ✓ | Display name shown in the gallery |
| `description` | string | ✓ | One or two sentences describing what the extension does |
| `category` | `"plugin" \| "skill" \| "command" \| "agent" \| "tool" \| "container"` | ✓ | Extension sub-type. Note: `container` represents Channels, which are a separate top-level concept from Extensions; it is included here for registry completeness but is not an Extension sub-type. |
| `risk` | `"lowest" \| "low" \| "medium" \| "medium-high" \| "highest"` | ✓ | Honest self-assessed risk level |
| `author` | string | ✓ | Your name, GitHub handle, or org |
| `version` | string | ✓ | Semantic version (e.g., `1.0.0`) |
| `source` | string | ✓ | npm package name, Docker image, or GitHub URL |
| `tags` | string[] | ✓ | Keywords for search (3–8 tags recommended) |
| `permissions` | string[] | ✓ | Plain-English list of what the extension accesses |
| `securityNotes` | string | ✓ | Honest security notes — what it can and cannot do |
| `installAction` | `"plugin" \| "skill-file" \| "command-file" \| "agent-file" \| "tool-file" \| "compose-service"` | ✓ | How OpenPalm installs this extension |
| `installTarget` | string | ✓ | npm package, skill file path, or compose service name |
| `docUrl` | string | | Optional link to documentation |

### Risk level guidance

Risk levels map directly to Extension sub-types:

- **lowest** — Skill: behavioral directive only (no network, no disk writes, no side effects)
- **low** — Command: slash command definition; minimal side effects
- **medium** — Agent: specialized assistant persona; inherits tool access from its configuration
- **medium-high** — Custom Tool: TypeScript callable function; executes code with defined I/O
- **highest** — Plugin: lifecycle hooks; can intercept and modify any OpenCode operation

### installAction guide

| `installAction` | `installTarget` example | What happens |
|---|---|---|
| `plugin` | `@myorg/my-opencode-plugin` | Added to `plugin[]` in `opencode.json`; OpenCode core restarts |
| `skill-file` | `skills/MySkill.SKILL.md` | Skill file copied into `skills/` and enabled in agent config |
| `command-file` | `commands/my-command.md` | Command file copied into `commands/` |
| `agent-file` | `agents/my-agent.md` | Agent file copied into `agents/` |
| `tool-file` | `tools/my-tool.ts` | Tool file copied into `tools/` |
| `compose-service` | `my-service` | Docker Compose service started via admin |

## Example entry

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "description": "A short description of what this plugin does.",
  "category": "plugin",
  "risk": "highest",
  "author": "your-github-handle",
  "version": "1.0.0",
  "source": "@example/my-opencode-plugin",
  "tags": ["productivity", "example"],
  "permissions": ["tool.execute.before hook"],
  "securityNotes": "Read-only hook. No network access, no side effects.",
  "installAction": "plugin",
  "installTarget": "@example/my-opencode-plugin",
  "docUrl": "https://github.com/example/my-opencode-plugin"
}
```

## Review criteria

Pull requests adding registry entries will be checked for:

- All required fields present and non-empty
- Honest risk level — understating risk is grounds for rejection
- `source` points to a real, publicly accessible package or image
- `securityNotes` accurately describes what the extension can and cannot do
- No duplicate `id` with an existing entry

Maintainers reserve the right to remove entries that are abandoned, insecure, or misrepresent their capabilities.
