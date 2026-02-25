---
description: "Explain Ralph Wiggum technique and available commands"
---

# Ralph Wiggum Plugin Help

Please explain the following to the user:

## What is the Ralph Wiggum Technique?

The Ralph Wiggum technique is an iterative development methodology based on continuous AI loops, pioneered by Geoffrey Huntley.

**Core concept:**
```bash
while :; do
  cat PROMPT.md | opencode --continue
done
```

The same prompt is fed to the agent repeatedly. The "self-referential" aspect comes from the agent seeing its own previous work in the files and git history, not from feeding output back as input.

**Each iteration:**
1. The agent receives the SAME prompt
2. Works on the task, modifying files
3. Session goes idle (completes)
4. The `ralph-wiggum` plugin intercepts the `session.idle` event and sends the same prompt again
5. The agent sees its previous work in the files
6. Iteratively improves until completion

The technique is described as "deterministically bad in an undeterministic world" - failures are predictable, enabling systematic improvement through prompt tuning.

## Available Commands

### /ralph-loop <PROMPT> [OPTIONS]

Start a Ralph loop in your current session.

**Usage:**
```
/ralph-loop "Refactor the cache layer" --max-iterations 20
/ralph-loop "Add tests" --completion-promise "TESTS COMPLETE"
```

**Options:**
- `--max-iterations <n>` - Max iterations before auto-stop
- `--completion-promise <text>` - Promise phrase to signal completion
- `--worktree <path>` - Create state file inside a worktree instead of repo root

**How it works:**
1. Creates a `ralph-loop.local.md` state file (at repo root or in worktree)
2. You work on the task
3. When the session goes idle, the `ralph-wiggum` plugin intercepts via `session.idle`
4. Same prompt fed back via `client.session.promptAsync()`
5. You see your previous work in files and git history
6. Continues until promise detected or max iterations

---

### /implement-tasks <DESCRIPTION>

Start a Ralph loop in a dedicated git worktree. Multiple instances can run in parallel, each in its own worktree with its own state file.

**Usage:**
```
/implement-tasks Add user authentication
/implement-tasks Build dashboard   <-- runs in parallel in a separate session
```

**How it works:**
1. Creates a new git worktree under `.worktrees/`
2. Creates `ralph-loop.local.md` inside the worktree's `.opencode/` directory
3. The plugin discovers and claims the state file on the first `session.idle`
4. Each session works independently in its own worktree

---

### /cancel-ralph [SESSION_ID]

Cancel active Ralph loop(s).

**Usage:**
```
/cancel-ralph              <-- cancels all active loops
/cancel-ralph ses_xxxxx    <-- cancels a specific session's loop
```

**How it works:**
- Checks for active loops at repo root and in all worktrees
- Reads `.opencode/worktrees.local.json` for the session registry
- Removes targeted state files and cleans up the registry
- Reports cancellation with iteration counts

---

## Multi-Worktree Parallel Loops

The plugin supports running multiple Ralph loops simultaneously, each in its own git worktree:

```
repo-root/
  .opencode/
    worktrees.local.json      <-- session-to-worktree registry
    ralph-loop.local.md        <-- direct (non-worktree) loop state
  .worktrees/
    task-impl-foo/
      .opencode/
        ralph-loop.local.md    <-- worktree-scoped state
    task-impl-bar/
      .opencode/
        ralph-loop.local.md    <-- worktree-scoped state
```

Each `session.idle` event is scoped to the session that triggered it. The plugin maintains per-session guards and a global claim lock to prevent races.

---

## Key Concepts

### Completion Promises

To signal completion, the agent must output a `<promise>` tag:

```
<promise>TASK COMPLETE</promise>
```

The plugin looks for this specific tag. Without it (or `--max-iterations`), Ralph runs infinitely.

### Self-Reference Mechanism

The "loop" doesn't mean the agent talks to itself. It means:
- Same prompt repeated
- The agent's work persists in files
- Each iteration sees previous attempts
- Builds incrementally toward goal

## Example

### Interactive Bug Fix

```
/ralph-loop "Fix the token refresh logic in auth.ts. Output <promise>FIXED</promise> when all tests pass." --completion-promise "FIXED" --max-iterations 10
```

### Parallel Task Implementation

```
# Session 1:
/implement-tasks Add user auth

# Session 2 (separate terminal):
/implement-tasks Build dashboard
```

Both loops run independently in their own worktrees.

## When to Use Ralph

**Good for:**
- Well-defined tasks with clear success criteria
- Tasks requiring iteration and refinement
- Iterative development with self-correction
- Greenfield projects
- Parallel workstreams with independent tasks

**Not good for:**
- Tasks requiring human judgment or design decisions
- One-shot operations
- Tasks with unclear success criteria
- Debugging production issues (use targeted debugging instead)

## Learn More

- Original technique: https://ghuntley.com/ralph/
- Ralph Orchestrator: https://github.com/mikeyobrien/ralph-orchestrator
