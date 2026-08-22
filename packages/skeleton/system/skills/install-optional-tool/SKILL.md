---
name: install-optional-tool
lint_skip: [stale-path]
description: Install an optional CLI tool that is not baked into the assistant image (Codex CLI, Claude Code, GitHub Copilot CLI, Pi Coding Agent, or the Google Cloud CLI) on request. Use this skill whenever the user asks to use, install, or run one of these tools and it is not already on PATH.
updated: 2026-08-08
---

# Install Optional Tool

The assistant image ships OpenCode as its runtime plus a small fixed set of
CLIs (`gh`, `uv`, `jq`, `sqlite3`, `git`). A handful of other CLIs are
supported but installed **on request** instead of baked into every image,
because most installs never use them:

| Tool id | What it is |
|---|---|
| `codex` | OpenAI's Codex CLI |
| `claude` | Anthropic's Claude Code CLI |
| `copilot` | GitHub's Copilot CLI |
| `pi` | Pi Coding Agent |
| `gcloud` | Google Cloud CLI |

## When to use this skill

Use it when the user asks to run one of the tools above and it is not
already on PATH, or when another skill needs one of them and it isn't
installed yet.

## Before you start

Check whether the tool is already installed — the install script does this
too, but checking first avoids an unnecessary step:

```bash
which <tool-id-or-binary>
```

If it's already on PATH, nothing to do.

## Installing a tool

Run the install script from this skill's directory with the tool id from
the table above:

```bash
bash scripts/install-tool.sh <tool-id>
```

For example:

```bash
bash scripts/install-tool.sh codex
bash scripts/install-tool.sh gcloud
```

To see the full list of supported tools and their ids:

```bash
bash scripts/install-tool.sh --list
```

## How it works

- The manifest (`tools.json`) lists each supported tool's package/version
  and how to install it. Do not hand-edit installed paths.
- Everything installs into `/opt/persistent` — the `assistant-persistent`
  named volume, which is the one part of the assistant's writable layer that
  survives `docker compose up --force-recreate` and image upgrades (see
  `docs/operations/persistent-assistant-tools.md`). `/opt/persistent/bin` is
  already on PATH.
- The script checks whether the tool's binary already resolves on PATH
  before doing any work, so re-running it for an already-installed tool is a
  fast no-op — safe to call every time rather than trying to remember
  whether a tool was installed in a previous session.
- npm-based tools (`codex`, `claude`, `copilot`, `pi`) install via
  `npm install -g --prefix /opt/persistent <package>@<version>`, pinned to
  the same versions OpenPalm used to bake into the image.
- `gcloud` downloads the official Google Cloud CLI tarball and extracts it
  under `/opt/persistent/google-cloud-sdk`, then symlinks `gcloud`,
  `gsutil`, and `bq` into `/opt/persistent/bin`. Its own config directory
  defaults to `$HOME/.config/gcloud`, which already persists via the
  assistant's home bind mount.

## Adding a new tool

To make a new optional tool installable this way, add an entry to
`tools.json` — either `"kind": "npm"` with `package`/`version`/`bin`, or a
new `kind` handled in `scripts/install-tool.sh` for non-npm installers. This
is the one place to add the next on-demand tool.
