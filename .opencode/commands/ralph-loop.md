---
description: "Start Ralph Wiggum loop in current session"
---

Run the following bash command to initialize the Ralph loop:

```
.opencode/skills/ralph-wiggum/scripts/setup-ralph-loop.sh " $ARGUMENTS "
```

After the setup script completes successfully, begin working on the task described in the arguments above. The `ralph-wiggum` plugin monitors `session.idle` and will automatically re-inject this same prompt after each iteration, allowing you to build on your previous work incrementally.

If multiple tasks are provided, complete one task at a time. Do not return the completion promise until all tasks are completed.

CRITICAL RULE: If a completion promise is set, you may ONLY output it when the statement is completely and unequivocally TRUE. Do not output false promises to escape the loop, even if you think you're stuck or should exit for other reasons. The loop is designed to continue until genuine completion.
