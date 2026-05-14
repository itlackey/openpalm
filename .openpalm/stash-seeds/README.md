# Stash Seeds

Seed assets for the shared akm stash. These files are copied into
`${OP_HOME}/data/stash/` on first install by `seedStashAssets()`.

## Layout

```
stash-seeds/
├── skills/        # Skills (directories with SKILL.md + frontmatter)
├── commands/      # Slash commands (flat .md files)
└── agents/        # Agent personas (flat .md files)
```

## Conventions

- **Skills** are directories containing a `SKILL.md` with YAML frontmatter
  (`name`, `type: skill`, `description`, `when_to_use`). Supporting files
  live alongside `SKILL.md`. Resolved via `akm show skill:<name>`.
- **Commands** are flat markdown files with YAML frontmatter
  (`name`, `type: command`, `description`, `when_to_use`).
  Resolved via `akm show command:<name>`.
- **Agents** are flat markdown files with YAML frontmatter
  (`name`, `type: agent`, `description`, `when_to_use`).
  Resolved via `akm show agent:<name>`.

## Seeding Rules

- First install copies every seed into `${OP_HOME}/data/stash/<type>/<name>...`.
- **Subsequent installs never overwrite existing files** — user edits win.
- Seeds are embedded into the CLI binary via Bun text imports, so a fresh
  install works offline.
