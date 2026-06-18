---
name: work
description: "route tokens: [W], [W-C]"
---

# Purpose

Start or continue a goal-mode work sequence for a named task. Use `[P]` for planning artifacts, `[R]` for review, and `[I]` for implementation.

# Core Workflow

For `[W] <task>`, create a goal with this sequence:

1. `[P]` discussion draft -> technical design; `[R]` review; update state; set goal to `blocked`.
2. `[W-C]`; `[P]` discussion draft + technical design -> todo; `[R]` review; update state; set goal to `blocked`.
3. `[W-C]`; `[I]` discussion draft + technical design + todo -> implementation; `[R]` review; report result.

# State & Resume

Maintain a temporary state file:

```text
reading-resources/未分类/YYYY-MM-DD-<task>-work-state.md
```

Before each `blocked`, update the state file and report: current stage, artifact paths, review result, continuation safety, next action, resume command, and suggested route for blocking findings. Delete the state file when the work goal is complete.

For `[W-C]`, read the state file and relevant artifacts before continuing. If no task is specified, resume the only `*-work-state.md`; if multiple exist, ask the user to choose; if none exist, report no active blocked work goal. Do not restart from Stage 1 unless explicitly requested.

# Artifact Naming

Do not rename an existing discussion draft; record its real path in the state file. Use:

* `reading-resources/未分类/YYYY-MM-DD-<task>-design.md`
* `reading-resources/未分类/YYYY-MM-DD-<task>-todo.md`
* `reading-resources/未分类/YYYY-MM-DD-<task>-work-state.md`

# Rules

* Do not replace `[P]`, `[R]`, or `[I]`; delegate stage behavior to those skills.
* If the task name is missing for `[W]`, ask for it.
* If no discussion draft exists, do not start Stage 1. Ask the user to create or complete one with `[D]`, or provide an existing discussion draft path.
* If `[R]` finds blocking issues, set the next action to waiting for the user to handle or accept the findings. Do not continue to the next stage automatically.
* Do not perform implementation during Stage 1 or Stage 2.
* Do not set the goal to `blocked` after Stage 3 unless explicitly requested or unresolved blocking issues remain.