---
name: review
description: "route tokens: [R]"
---

# Purpose

Review code, design, or documentation changes for bugs, risks, behavioral regressions, and missing verification. Do not modify files unless explicitly asked.

# Output

Lead with findings. Order findings by severity, and include precise file and line references when available.

If no issues are found, say so clearly and mention any remaining test gaps or residual risk.

# Workflow

1. Identify the change set, target files, or material to review.
2. Read the minimum context needed to understand behavior and contracts.
3. Look for bugs, regressions, edge cases, consistency issues, and missing tests.
4. Report findings first, ordered by severity, with file and line references.
5. Briefly state assumptions, test gaps, and residual risk.
