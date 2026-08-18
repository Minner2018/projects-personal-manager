---
name: implement
description: "route tokens: [I]"
---

# Purpose

Implement a clearly scoped code change. Keep the change minimal, follow existing project patterns, and avoid unrelated refactors unless they are required to complete the request.

# Workflow

1. Define the success criteria and confirm the implementation scope.
2. Read only the necessary context, including relevant source, tests, configuration, and existing patterns.
3. When creating or modifying manually authored source code, read [the unified source-code standard](../../references/source-code-standard.md) completely before editing and apply its `[I]` formatting and commenting requirements to every source file changed by the task. Do not load it for documentation-only, configuration-only, dependency-metadata-only, or generated-code changes.
4. Make the smallest coherent implementation that satisfies the scope and preserves the required formatting and comment-led layered understandability.
5. Review all changed source against the unified reference checklist, correct formatting and missing or low-value comments, and ensure comments remain consistent with the final code.
6. Run relevant verification, such as tests, type checks, linting, or targeted manual checks.
7. Report the result, verification performed, unified source-standard review, and any remaining risk.
