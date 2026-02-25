---
description: "Cancel active Ralph Wiggum loop(s)"
---

# Cancel Ralph

To cancel Ralph loops, check all possible locations for active state files:

1. **Check the registry** — Read `.opencode/worktrees.local.json` using Bash: `cat .opencode/worktrees.local.json 2>/dev/null || echo "{}"`

2. **Check the repo root state file** — `test -f .opencode/ralph-loop.local.md && echo "ROOT_EXISTS" || echo "ROOT_NOT_FOUND"`

3. **Check worktree state files** — `ls .worktrees/*/.opencode/ralph-loop.local.md 2>/dev/null || echo "NO_WORKTREE_LOOPS"`

4. **If no active loops found anywhere**: Say "No active Ralph loops found."

5. **If active loops found**:
   - For each state file found, read it to get the current `iteration:` and `session_id:` values
   - List all active loops with their location, iteration count, and session ID
   - If the user provided a session ID argument (`$ARGUMENTS`), only cancel that specific loop's state file. Otherwise cancel all active loops.
   - Remove each targeted state file using Bash: `rm <path-to-state-file>`
   - Also clean up the registry: remove cancelled entries from `.opencode/worktrees.local.json` (or delete the file if all loops are cancelled)
   - Report: "Cancelled N Ralph loop(s)" with details of each (location, iteration count)
