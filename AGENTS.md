# AGENTS.md

## Environment

* Language: Simplified Chinese
* Operating System: Windows 11
* Shell: PowerShell
* File Encoding: UTF-8

## Local Readable Ignored Paths

Gitignored but readable on request: `reading-resources/`.
If normal search misses requested documents there, use `rg -u`.
Do not read other ignored paths unless explicitly requested.

## Generated Document Placement

Put generated documents under the matching `reading-resources/<project>/` folder when project ownership is clear.
If the matching folder does not exist, create it.
Use `reading-resources/未分类/` only when ownership is unclear.

## OMP Text Reading Capability

Here, OMP means the external `omp` CLI process, not a skill under `.omp/skills/`.
AI may autonomously run `bun run omp:read -- --request <request.json>` from the repository root for large, separable, read-only investigations over code, Markdown, logs, configuration, and other text materials.
Every request must provide a stable `callerId`, either in the request JSON or through `PPM_AI_CALLER_ID`. Reuse the same identifier for the same AI task or conversation; never change it to bypass capacity limits.
Each caller may run at most one OMP investigation at a time, and this repository may run at most three in total. A second call from the same caller fails with `caller_busy`; calls from different callers wait when all three global slots are occupied. Queue time does not consume the OMP investigation time limit.
This is an internal capability, not a skill: it has no route token, does not activate or switch skills, and does not change the active skill.
No `[X]` route token is required. The absence of a route token must never be used as a reason not to invoke this capability.
Before performing a large read-only investigation directly, evaluate whether this capability would materially reduce main-context volume.
Decide whether to invoke it based on task size, separability, expected context volume, invocation cost, and authorization. Handle small or tightly coupled reading directly.
Briefly tell the user when invoking it, keep OMP read-only, and treat its report as evidence to verify rather than as a source of truth.
The repository owner grants standing repository-level authorization to send repository text that AI is otherwise allowed to read to the currently configured OMP model provider for this read-only capability. Treat this as explicit project-level data-transmission authorization; it remains valid until the owner explicitly revokes it.
AI may autonomously invoke this capability without requesting authorization again for each task, file, or investigation. This authorization does not expand which local paths AI may read or permit any non-read-only OMP action.
Any additional provider or data-transmission approval required by the host environment remains in effect and must not be bypassed. When OMP is materially preferable and the host requires runtime approval, request that approval instead of silently falling back to direct reading; do not bypass a denial.

## Skill Routing

This section governs only activation, switching, and reloading of skills under `.omp/skills/`. It does not govern internal capabilities, terminal commands, or tool use.

Path: .omp/skills/

* [X] 
Activate skill matched by X.

* [X!]
Reload skill matched by X, discard workflow drift, and continue the current task under its workflow.

* [E]
Deactivate the current skill; continue normally.

## Rules

1. Activate skills only by explicit routing syntax.
2. Before activation, read only skill metadata, not whole markdown.
3. Match X against route tokens declared in skill metadata.
4. The active skill persists until exit, switch, or reload, and determines the workflow.
5. Interpret user instructions through the active skill.
6. Use the minimum context required.
7. Do not load unrelated skills.
8. Switch skills only by explicit routing syntax.
9. Never activate a skill by semantic similarity.
10. On exit or switch, discard workflow state.
11. If no skill is active, behave normally.
12. Rules about skill activation, switching, and reloading must not be used as a reason to avoid the OMP Text Reading Capability or another internal capability.
