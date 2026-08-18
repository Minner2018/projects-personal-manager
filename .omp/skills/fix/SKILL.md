---
name: fix
description: "route tokens: [F]"
---

# Purpose

Diagnose and fix a known defect. Confirm the observed behavior before changing code when practical, identify the cause, and keep the fix minimal and targeted.

# Workflow

1. Reproduce or confirm the defect and expected behavior.
2. Read the minimum context needed to locate the cause.
3. When modifying manually authored source code, read [the unified source-code standard](../../references/source-code-standard.md) completely before editing and apply its `[F]` formatting and commenting requirements within the fix scope. Do not load it for documentation-only, configuration-only, dependency-metadata-only, or generated-code changes.
4. Identify the root cause or the most defensible likely cause.
5. Make the smallest targeted fix without unrelated formatting or comment expansion.
6. Review changed source against the unified reference checklist and synchronize comments affected by the fix.
7. Run verification that would fail before the fix or otherwise protects the corrected behavior.
8. Report the cause, fix, source-standard review, verification performed, and remaining risk.
