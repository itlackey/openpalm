---
name: ralph-wiggum
description: |
  Implements the Ralph Wiggum iterative development loop technique for OpenCode.
  Uses the session.idle event to automatically restart sessions with the same prompt
  until a completion promise is detected or max iterations are reached.
  Supports multiple concurrent loops in parallel git worktrees.
  Ideal for TDD loops, iterative refinement, and long-running autonomous tasks.
  
  Commands available after installation:
  - /ralph-loop <prompt> [--max-iterations N] [--completion-promise TEXT]
  - /implement-tasks <task description>
  - /cancel-ralph [session-id]
  - /ralph-help
---

# Ralph Wiggum Skill

The Ralph Wiggum technique implements iterative development loops by intercepting OpenCode's
`session.idle` event and re-injecting the same prompt, allowing the agent to build on its
previous work across iterations.

## Installation

Copy the files from this skill into your project's `.opencode/` directory:

```bash
# Plugin (required -- implements the loop)
cp .opencode/skills/ralph-wiggum/plugins/ralph-wiggum.ts .opencode/plugins/

# Commands (optional but recommended)
cp .opencode/skills/ralph-wiggum/commands/ralph-loop.md .opencode/commands/
cp .opencode/skills/ralph-wiggum/commands/cancel-ralph.md .opencode/commands/
cp .opencode/skills/ralph-wiggum/commands/help.md .opencode/commands/ralph-help.md
```

The setup script ensures `./plugins/ralph-wiggum.ts` is present in `.opencode/opencode.json` so the plugin is enabled.

## Usage

Start a Ralph loop:

```
/ralph-loop Build a REST API for todos --completion-promise "COMPLETE" --max-iterations 20
```

Start parallel loops in worktrees (via implement-tasks):

```
/implement-tasks Add user auth
/implement-tasks Build dashboard   <-- runs in parallel in a separate worktree
```

Cancel active loops:

```
/cancel-ralph           <-- cancels all active loops
/cancel-ralph ses_xxx   <-- cancels a specific session's loop
```

## How It Works

1. `/ralph-loop` runs `scripts/setup-ralph-loop.sh` to create a state file (iteration starts at 0)
2. The `ralph-wiggum.ts` plugin listens for `session.idle` events
3. On idle, it scans for state files: repo root `.opencode/` and `.worktrees/*/.opencode/`
4. Each session claims the first unclaimed state file it finds (per-session guards prevent races)
5. Checks max iterations and completion promise against the last assistant message
6. If not complete, increments the iteration counter and re-injects the prompt via `client.session.promptAsync()` (fire-and-forget, returns immediately)
7. The loop ends when the completion promise `<promise>TEXT</promise>` is detected, or max iterations is reached

## State Files

Loop state is tracked in `ralph-loop.local.md` files (gitignored by convention):

- **Repo root**: `.opencode/ralph-loop.local.md` -- for direct `/ralph-loop` commands
- **Worktrees**: `.worktrees/<name>/.opencode/ralph-loop.local.md` -- for `/implement-tasks` commands

```yaml
---
active: true
session_id: "__PENDING_CLAIM__"
iteration: 1
max_iterations: 20
completion_promise: "COMPLETE"
started_at: "2026-01-01T00:00:00Z"
---

Your task prompt goes here...
```

## Registry

The plugin maintains `.opencode/worktrees.local.json` mapping active sessions to their worktrees:

```json
{
  "ses_xxxxx": {
    "branch": "task-impl/foo-20260225",
    "path": "/abs/.worktrees/task-impl-foo-20260225",
    "iteration": 3,
    "started_at": "2026-02-25T16:08:30Z"
  }
}
```

Updated on every iteration and on claim/completion.

## Session Scoping

The plugin only acts on `session.idle` events from the session that started the loop.
On initialization, `session_id` is `"__PENDING_CLAIM__"` until the first idle event -- the
plugin then claims the loop, writing the concrete session ID into the state file. Subsequent idle events
from other sessions are ignored. This prevents the loop from hijacking unrelated sessions.

Multiple sessions can run in parallel, each claiming a different state file.

## Completion Promises

To signal completion, the agent must output a `<promise>` tag:

```
<promise>COMPLETE</promise>
```

The plugin detects this in the last assistant message and stops the loop.
The agent should only output the promise when the stated goal is genuinely true.
