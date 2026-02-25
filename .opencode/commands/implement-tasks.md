---
description: "Start a Ralph loop that implements each task in the task list with review and approval"
---

Run the following bash commands to set up the worktree and initialize the Ralph loop. Both scripts must run from the repo root so the state files are created in the correct location:

```
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE=$("$REPO_ROOT/.opencode/skills/ralph-wiggum/scripts/setup-worktree.sh" "$ARGUMENTS" | tail -n1)
"$REPO_ROOT/.opencode/skills/ralph-wiggum/scripts/setup-ralph-loop.sh" --worktree "$WORKTREE" "implement-tasks in worktree $WORKTREE: $ARGUMENTS  VERY IMPORTANT: when all tasks are complete, reply with only <promise>ALL TASKS COMPLETE</promise>" --completion-promise "ALL TASKS COMPLETE"
```

**All implementation work must be performed inside the worktree.** After the setup commands complete, `cd` into the worktree path printed by the setup script and do not leave it during the loop. The worktree path is embedded in the Ralph prompt text above, so you can reference it on every iteration.

After the setup script completes successfully, begin the following workflow:

1. **Navigate to the worktree** — the worktree path was printed by the setup script and is embedded in the Ralph prompt. `cd` to the worktree path before doing any other work. Every file edit, test run, and git commit must happen inside the worktree.

2. **Read the task list** from `.plans/tasks.json` (inside the worktree). Find the next task (or subtask) whose status is not `completed`. If all tasks are completed, proceed to the **Finish** step below. **CRITICAL** Each iteration should only focus on a single task.

3. **Implement the task** — make the code, config, docs, or script changes described in the task. Use the file and line references in the task entry to locate the relevant areas.

4. **Write tests** — dispatch a sub-agent to write tests that verify the implementation is correct. Tests must follow the project conventions (`bun:test`, `describe`/`it`/`expect`).

5. **Review** — dispatch a separate reviewer agent to examine the implementation and the tests. The reviewer must check:
   - Correctness and completeness relative to the task description
   - Code quality and alignment with project conventions (see `AGENTS.md`)
   - Test coverage and accuracy
   - The reviewer must produce a written verdict: **APPROVED** or **CHANGES REQUESTED** with specific, actionable feedback.

6. **Iterate** — if the reviewer returns **CHANGES REQUESTED**, address every piece of feedback and repeat steps 4-5 until the reviewer returns **APPROVED**.

7. **Update task status** — once approved, update the task's `status` field to `"completed"` in `.plans/tasks.json`, then `git add -A && git commit -m "task: <task title>"` from within the worktree.

8. **Loop** — Complete the session once the status is complete and the changes are committed. Each iteration should only focus on a single task. The ralph-wiggum plugin will re-inject this prompt automatically. Return to step 1 and pick the next incomplete task.

**Finish (all tasks complete):**
- Determine the branch name: `git -C <worktree-path> branch --show-current`
- Push the branch: `git -C <worktree-path> push -u origin <branch>`
- Open a pull request from the branch to `main` with a summary of all completed tasks and references to `.plans/tasks.json`
- Output the completion promise: `<promise>ALL TASKS COMPLETE</promise>`

CRITICAL RULE: Do not mark a task as `completed` until the reviewer has explicitly returned **APPROVED**. Do not output the completion promise until every task in the list has status `"completed"` AND the PR has been opened. The loop is designed to continue until genuine completion.
