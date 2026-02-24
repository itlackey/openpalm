---
name: ralph-wiggum
description: |
  Implements the Ralph Wiggum iterative development loop technique for OpenCode.
  Uses the session.idle event to automatically restart sessions with the same prompt
  until a completion promise is detected or max iterations are reached.
  Ideal for TDD loops, iterative refinement, and long-running autonomous tasks.
  
  Commands available after installation:
  - /ralph-loop <prompt> [--max-iterations N] [--completion-promise TEXT]
  - /cancel-ralph
  - /ralph-help
---

# Ralph Wiggum Skill

The Ralph Wiggum technique implements iterative development loops by intercepting OpenCode's
`session.idle` event and re-injecting the same prompt, allowing the agent to build on its
previous work across iterations.

## Installation

Copy the files from this skill into your project's `.opencode/` directory:

```bash
# Plugin (required — implements the loop)
cp .opencode/skills/ralph-wiggum/plugins/ralph-wiggum.ts .opencode/plugins/

# Commands (optional but recommended)
cp .opencode/skills/ralph-wiggum/commands/ralph-loop.md .opencode/commands/
cp .opencode/skills/ralph-wiggum/commands/cancel-ralph.md .opencode/commands/
cp .opencode/skills/ralph-wiggum/commands/help.md .opencode/commands/ralph-help.md
```

The plugin is automatically loaded by OpenCode from `.opencode/plugins/`. No config changes needed.

## Usage

Start a Ralph loop:

```
/ralph-loop Build a REST API for todos --completion-promise "COMPLETE" --max-iterations 20
```

Cancel an active loop:

```
/cancel-ralph
```

## How It Works

1. `/ralph-loop` runs `scripts/setup-ralph-loop.sh` to create `.opencode/ralph-loop.local.md`
2. The `ralph-wiggum.ts` plugin listens for `session.idle` on every session
3. On idle, it checks for the state file to see if a loop is active
4. If active and not complete, it increments the iteration counter and sends the same prompt back
5. The loop ends when the completion promise is found in the last assistant message, or max iterations is reached

## State File

The loop state is tracked in `.opencode/ralph-loop.local.md` (gitignored by convention):

```yaml
---
active: true
iteration: 1
max_iterations: 20
completion_promise: "COMPLETE"
started_at: "2026-01-01T00:00:00Z"
---

Your task prompt goes here...
```

## Completion Promises

To signal completion, the agent must output a `<promise>` tag:

```
<promise>COMPLETE</promise>
```

The plugin detects this in the last assistant message and stops the loop.
The agent should only output the promise when the stated goal is genuinely true.
