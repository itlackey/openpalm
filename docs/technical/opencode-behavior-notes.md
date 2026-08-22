# OpenCode behavior notes (v1.18.21)

Verified against the pinned source, not the docs. Re-check on every version bump.
Kept because each item cost real time to establish and is not discoverable from
config files.

## Config loading

- Merge order (later wins, `mergeDeep(target, source)`). `ConfigPaths.directories()`
  yields `~/.config/opencode` → project `.opencode` dirs → `~/.opencode` →
  `OPENCODE_CONFIG_DIR` (`config/paths.ts:23-41`). The managed dir is **not** an
  element of that list — it is merged separately, afterwards. On Linux it is
  `/etc/opencode`, and OpenPalm points `OPENCODE_CONFIG_DIR` at that same path, so
  the managed tree is merged twice and wins. Move the env var and the doubling
  stops. `config/config.ts:399,424-429,516-522`.
- Nested project `.opencode` dirs merge in the **opposite** order from
  `opencode.json` files: `ConfigPaths.files` calls `.toReversed()` so the nearest
  file wins; `ConfigPaths.directories` does not, and `FSUtil.up` returns
  nearest-first — so the **outermost** ancestor `.opencode` merges last and wins.
  `config/paths.ts:20,23-41`, `core/src/fs-util.ts:168-182`.
- `instructions` arrays are **set-unioned** across sources, not overridden. A
  user config can add instruction files the managed config cannot remove.
- Every directory in `ConfigPaths.directories()` gets `ensureGitignore()` plus
  `npm install @opencode-ai/plugin` — including `~/.config/opencode`. That is
  where the `node_modules` in both config trees comes from.
  `config.ts:424,436-446`.
- Declared npm plugins (`"plugin": [...]`) install to `Global.cache/packages`,
  **not** a config dir. `packages/core/src/npm.ts:79`.

## instructions resolution

- **Relative entries resolve from the session directory, not the config file's
  directory**, via `globUp(pattern, session.directory, session.worktree)`, which
  only walks upward. `/etc/opencode` is not an ancestor of `/work`, so
  `"./instructions/core.md"` silently loads nothing — no error, no log. One
  escape hatch: under `OPENCODE_DISABLE_PROJECT_CONFIG` the call becomes
  `globUp(pattern, global.config, global.config)`, and `global.config` **is**
  `OPENCODE_CONFIG_DIR` — so that same relative entry does resolve.
  `session/instruction.ts:81-88`.
- Absolute entries use `fs.glob(basename, {cwd: dirname})`, so they resolve
  against their own path and are unaffected by `OPENCODE_CONFIG_DIR`.
  `packages/opencode/src/session/instruction.ts:135-148`.
- `~/` expands via `global.home`. `AGENTS.md` is read from
  `$OPENCODE_CONFIG_DIR/AGENTS.md` (`Global.Service.config` is flag-aware,
  `packages/core/src/global.ts:64`).
- File **contents** are re-read on every model call, so edits apply live. Adding
  or removing an array *entry* needs a process restart.

## Permission resources — one convention per tool

| Permission | Resource asserted |
|---|---|
| `bash` | raw source text, **once per parsed command node** — except nodes headed by `cd`, `chdir`, `popd`, `pushd`, `push-location`, `set-location`, which assert no `bash` permission at all (`tool/shell.ts:28,407-410`) |
| `read` | path **relative to the worktree** (`tool/read.ts:255-259`) |
| `edit` | path **relative to the worktree**. `write` and `apply_patch` assert this same `edit` key — there is no `write` or `patch` permission, and no `tool/patch.ts` (`tool/write.ts:54-57`, `tool/apply_patch.ts:206-209`) |
| `external_directory` | the target's **parent dir + `/*`** (`tool/external-directory.ts:28-43`) |

- **The worktree is `/`, not `/work`.** OpenCode discovers a git repo upward from
  the session dir; `/work` is never `git init`-ed, so it resolves to the global
  project rooted at `/`. `path.relative` therefore yields `stash/secrets/x`, with
  no leading `../`. `packages/core/src/project.ts:110-112`,
  `packages/opencode/src/project/project.ts:217,309`.
- Bash also asserts `external_directory` for directories a command touches, so
  it is not path-blind — but it performs no `read`/`edit` check.

## Matching and precedence

- Permission matching uses `packages/core/src/util/wildcard.ts:3-14`, imported by
  `packages/opencode/src/permission/index.ts:4` — **not** the same-named
  `packages/opencode/src/util/wildcard.ts`, which adds `all`/`allStructured`
  helpers that sort by pattern length and is not on this path. Behavior:
  regex-escape, `*`→`.*`, `?`→`.`, anchored `^...$`. `/` is not special, so `*`
  crosses directories — `"*.env"` matches `stash/secrets/.env`. Because the regex
  is anchored, a leading `*` is a **suffix** match (`*foo` → `^.*foo$`); a real
  substring match needs `*foo*`. A trailing `" *"` becomes `"( .*)?"`, making the
  argument optional — which is why `"sudo"` matches only bare `sudo` and
  `"sudo *"` matches both.
- Rules are a flat concat evaluated with `findLast` — **last match wins** — and
  key order inside a block is preserved (`propertyOrder: "original"`), so a deny
  must come after the allow it narrows.
  `packages/opencode/src/permission/index.ts:28-38,186-202`.
- Session approvals are appended last, so an "always" click outranks config.
  Bash installs the **arity prefix** (`sudo rm -rf /x` → `sudo *`); edit/write
  install `*`. A denied call never prompts, so it cannot be clicked away.
- Built-in defaults include `read: {"*": "allow", "*.env": "ask", "*.env.*":
  "ask", "*.env.example": "allow"}`. A user-level `read: {"*": "allow"}` is
  merged after and removes that protection. `agent/agent.ts:119-152`.
- **`OPENCODE_PERMISSION` outranks the managed config.** The env var is parsed as
  JSON and `mergeDeep`ed into `result.permission` *after* the `/etc/opencode`
  merge, so anything able to set it can loosen a managed deny. `result.tools` is
  likewise translated into permissions (`write`, `edit` and `patch` all collapse
  to `perms.edit`), though `mergeDeep(perms, result.permission ?? {})` lets an
  explicit `permission` block win over `tools`.
  `config/config.ts:545-551,553-564`.
