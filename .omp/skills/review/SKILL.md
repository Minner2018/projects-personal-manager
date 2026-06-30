---
name: review
description: "route tokens: [R]"
---

# Purpose

Review code, design, or documentation changes for concrete risks: bugs, regressions, missing verification, counterexamples, coupling, and maintainability. Do not modify files unless explicitly asked.

# Focus

Adjust focus to the target. For non-trivial changes, actively search for counterexamples: edge cases, failure paths, conflicting requirements, missing states, and assumptions that may not hold.

Report only issues that apply to the target's documented or observed runtime path. Downgrade or omit excluded-scope, contradicted, or purely hypothetical cases.

Report coupling or maintainability only when it creates concrete risk, such as unclear ownership, hidden dependencies, duplicated logic, state coupling, or hard-to-test behavior.

# Findings

Lead with findings, ordered by severity:

* `P0`: severe failure, data/security issue, production incident, or blocked goal.
* `P1`: major functional error, unmet key requirement, or wrong decision.
* `P2`: concrete edge-case, maintainability, test, or rework risk.
* `P3`: minor clarity or consistency issue affecting maintainability or future review.

Each finding must state the issue, concrete impact, and evidence. Prefer file/line references; for designs or documents, cite the relevant section, assumption, missing case, or verification gap.

# Result

End with `Review Result: pass | concern | block`.

* `pass`: no blocking findings found; still state residual risks or test gaps.
* `concern`: objective risks exist; consider whether to address them before continuing.
* `block`: P0/P1 exists, or material is insufficient to judge critical risk.

# Boundaries

Do not suggest next route or perform implementation/design work. If no issues are found, say so clearly and mention remaining test gaps or residual risk.
