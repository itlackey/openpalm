---
description: "Dispatch agents to generate implementation plans and a task list from recommendations"
---

Dispatch agents for each recommendation to generate an implementation plan for the recommendation with a list of steps that need to be taken to update the code/docs/tests/scripts/etc to fully implement the recommendation. Have each agent write the plan to a new md file in a `.plans` directory in the root of the repo. Once all plans are written, dispatch an agent to create a json file that is a list of all tasks and their subtasks. Each task and subtask should have a short description, status field, and references to files and line numbers related to the item. Write that file to the `.plans` folder as well. Once all files are written, do a final review of the plans and the task list. Make any corrections or adjustments you see fit to ensure the plans and tasks are complete and provide the necessary context to complete the tasks fully and reliably.

The recommendations to plan for: $ARGUMENTS
