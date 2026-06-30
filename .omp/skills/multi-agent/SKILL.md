---
name: multi-agent
description: "route tokens: [M]"
---

# Purpose & Scope

This task requires strict multi-agent handling, including delegation, independent review, a board, Git Trace, or risk control. If the main flow can split out delegable work, it must delegate. The main flow may answer directly only for one round when no useful subagent task can be separated.

# Main Flow

The main flow owns clarification, decomposition, assignment, tracking, board/Git Trace, reviewer checks, and final decisions. Use skill `[D]` when discussion with the human is needed. Use skill `[R]` when review is needed.

The main flow must not take over delegable or assigned planning, research, implementation, testing, or fixing. After assignment ,on that assigned path the main flow may only track progress, update the board, handle escalations.

# Sub agents & Route

Only create subagents when need to use but no corresponding agent exists. Do not release or recreate them unless the human asks or the subagent is unusable.

* `agent_1`: model `5.5-high`; use route `[P]` and `[R]` for planning, review, and risk detection; do not write code.
* `agent_2`: model `5.5-medium`; use route `[T]` for file search, source/context gathering, research, and candidate drafts.
* `agent_3`: model `5.5-medium`; use route `[I]` and `[F]` for implementation, tests, and fixes.

# Assignment

Every assignment must include route, final goal, task, scope, acceptance criteria, and timebox.

When `agent_1` uses `[P]`, the main flow must run two reviewed stages before implementation: first require a planning file and review it with `[R]`; then require a todo file and review it with `[R]`. For later assignments on the same task, include the file paths so key details are not lost in summaries. Do not assign `agent_3` to execute until the todo is reviewed.

If a timebox expires, check subagent state before deciding whether the delay is normal or exceptional. Wait for all relevant subagent results on the current flow path before summarizing and deciding the next step.

# Board

Maintain:

```text
reading-resources/<(projects/<project>)-or-未分类>/YYYY-MM-DD-<task>-multi-agent-board.md
```

Follow repository document-placement rules. Keep `Flow Log` before `Task Board History`. Record workflow-significant events: assignments, results, reviews, risks, human confirmations, Git Trace, exceptions, and main-flow decisions. Store references, short summaries, decisions, and open questions, not full subagent outputs.

Task board snapshots must use:

```text
Agent | Task | Status | Timebox | Reviewer | Blocked By | Next
```

Allowed status values: `idle`, `pending`, `running`, `reviewing`, `done`, `blocked`, `skipped`.

# Git Trace

Git Trace applies when `[M]` includes code or repository changes. For discussion or research-only work, record Git Trace as N/A.

Before formal code work, ensure the board tracks the task branch; if not, discuss the base branch with the human, create one, and record it. Before each new code-generation round, commit the previous round's code changes in the concrete project path with a one-sentence message.

Ask the human if the board branch, current branch, or workspace state is unsafe or inconsistent.

# Review, Risk & Escalation

`agent_1` reviews outputs from `agent_2` and `agent_3` before the main flow decides, including research conclusions, implementation/test/fix results, conflicts, scope changes, and risks.

`agent_1` proposes; the main flow decides. The main flow must explicitly use skill `[R]` to review `agent_1`'s own plans, todo files, and reviews, and must not delegate that review back to `agent_1`. The main flow must check whether `agent_1`'s output fits the human goal, confirmed boundaries, evidence quality, and risk posture before accepting, modifying, or rejecting it.

Low risk may proceed if recorded and not need to hanled. Medium, high, or unclear risk must escalate before continuing. Treat destructive, external, paid, credential/permission, privacy/security, production/deployment, migration, or irreversible changes as at least medium risk.

If a subagent needs sandbox-external permissions, it must report the command or action, reason, risk, and alternatives. The main flow decides whether to request human approval.

# Completion

End when the goal is met, human decision is required, or one narrowed retry/review yields no useful output. State completed work, accepted/rejected/deferred subagent conclusions, remaining risks, and the next step or human decision needed.

# Rules

* Keep the main flow responsible for coordination and confirmation-gated actions.
* Use only needed subagents and never bypass required `agent_1` review.
* Do not override explicit human decisions or change the main goal without reporting the risk and getting confirmation.
