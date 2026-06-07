# AGENTS.md

## Environment

* Language: Simplified Chinese
* Operating System: Windows 11
* Shell: PowerShell
* File Encoding: UTF-8

## Skill Routing

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
