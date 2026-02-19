# OpenCode extension assets

Use this directory for install-time OpenCode extension defaults.

```text
assets/opencode/
  core/     # full assistant runtime config (plugins, skills, lib, AGENTS.md)
  gateway/  # restricted intake-agent config for gateway
```

These files are seeded by the installer into:

- `~/.config/openpalm/opencode-core/`
- `~/.config/openpalm/opencode-gateway/`
