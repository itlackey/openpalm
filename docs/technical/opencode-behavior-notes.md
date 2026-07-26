# OpenCode behavior notes (v1.17.13)

Verified against the pinned source, not the docs. Re-check on every version bump.
Kept because each item cost real time to establish and is not discoverable from
config files.

## Config loading

- Merge order (later wins, `mergeDeep(target, source)`):
  `~/.config/opencode` → project `.opencode` dirs → `OPENCODE_CONFIG_DIR` →
  `systemManagedConfigDir`. On Linux the last one **is** `/etc/opencode`, so the
  managed tree is merged twice and wins. `config/config.ts:398,423-428,515-521`.
- `instructions` arrays are **set-unioned** across sources, not overridden. A
  user config can add instruction files the managed config cannot remove.
- Every directory in `ConfigPaths.directories()` gets `ensureGitignore()` plus
  `npm install @opencode-ai/plugin` — including `~/.config/opencode`. That is
  where the `node_modules` in both config trees comes from. `config.ts:435-445`.
- Declared npm plugins (`"plugin": [...]`) install to `Global.cache/packages`,
  **not** a config dir. `core/src/npm.ts:79`.

## instructions resolution

- **Relative entries resolve from the session directory, not the config file's
  directory**, via `globUp(pattern, session.directory, session.worktree)`, which
  only walks upward. `/etc/opencode` is not an ancestor of `/work`, so
  `"./instructions/core.md"` silently loads nothing — no error, no log.
- Absolute entries use `fs.glob(basename, {cwd: dirname})`, so they resolve
  against their own path and are unaffected by `OPENCODE_CONFIG_DIR`.
  `session/instruction.ts:135-148`.
- `~/` expands via `global.home`. `AGENTS.md` is read from
  `$OPENCODE_CONFIG_DIR/AGENTS.md` (`Global.Service.config` is flag-aware,
  `core/src/global.ts:64`).
- File **contents** are re-read on every model call, so edits apply live. Adding
  or removing an array *entry* needs a process restart.

## Permission resources — one convention per tool

| Permission | Resource asserted |
|---|---|
| `bash` | raw source text, **once per parsed command node** (`tool/shell.ts:407-410`) |
| `read` | path **relative to the worktree** (`tool/read.ts:255-259`) |
| `edit` / `write` / `patch` | path **relative to the worktree** |
| `external_directory` | the target's **parent dir + `/*`** (`tool/external-directory.ts:28-43`) |

- **The worktree is `/`, not `/work`.** OpenCode discovers a git repo upward from
  the session dir; `/work` is never `git init`-ed, so it resolves to the global
  project rooted at `/`. `path.relative` therefore yields `stash/secrets/x`, with
  no leading `../`. `core/src/project.ts:110-112`, `project/project.ts:217,309`.
- Bash also asserts `external_directory` for directories a command touches, so
  it is not path-blind — but it performs no `read`/`edit` check.

## Matching and precedence

- `wildcard.ts`: regex-escape, `*`→`.*`, `?`→`.`, anchored `^...$`. `/` is not
  special, so `*` crosses directories and a **leading `*` is a substring match**.
  A trailing `" *"` becomes `"( .*)?"`, making the argument optional — which is
  why `"sudo"` matches only bare `sudo` and `"sudo *"` matches both.
- Rules are a flat concat evaluated with `findLast` — **last match wins** — and
  key order inside a block is preserved (`propertyOrder: "original"`), so a deny
  must come after the allow it narrows. `permission/index.ts:28-38,186-202`.
- Session approvals are appended last, so an "always" click outranks config.
  Bash installs the **arity prefix** (`sudo rm -rf /x` → `sudo *`); edit/write
  install `*`. A denied call never prompts, so it cannot be clicked away.
- Built-in defaults include `read: {"*": "allow", "*.env": "ask", "*.env.*":
  "ask", "*.env.example": "allow"}`. A user-level `read: {"*": "allow"}` is
  merged after and removes that protection. `agent/agent.ts:119-152`.
