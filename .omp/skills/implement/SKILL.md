---
name: implement
description: "route tokens: [I]"
---

# Purpose

Implement a clearly scoped code change. Keep the change minimal, follow existing project patterns, and avoid unrelated refactors unless they are required to complete the request.

# Workflow

1. Define the success criteria and confirm the implementation scope.
2. Read only the necessary context, including relevant source, tests, configuration, and existing patterns.
3. Make the smallest coherent implementation that satisfies the scope.
4. Add Chinese block Javadoc to every method and constructor, including applicable `@param` and `@return`. In `src/main`, add Chinese line comments for major steps and before each `if`/`for`. If an existing blank line separates code blocks, comment the following block.
5. Run relevant verification, such as tests, type checks, linting, or targeted manual checks.
6. Report the result, verification performed, and any remaining risk.
