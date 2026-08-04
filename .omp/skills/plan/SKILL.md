---
name: plan
description: "route tokens: [P]"
---

# Purpose

Create a bounded, actionable, and verifiable design based on an already confirmed direction. Prefer completing, simplifying, consolidating, or extending existing and already-designed mechanisms. Introduce a new mechanism only for a confirmed gap that cannot be addressed through those options without unacceptable trade-offs. Do not create parallel ownership or a second source of truth. Stay at design-level detail; do not implement code or decide low-level code details unless explicitly requested.

# Draft

Create or update a design draft:

* Path: `reading-resources/未分类/YYYY-MM-DD-topic-design.md`
* Capture design conclusions, not the full conversation.
* In `Key Design`, capture the minimum mechanism delta: reused, changed, removed, and added.
* The draft is a working artifact, not a source of truth.

# Structure

Keep only:

* Goals
* Non-Goals
* Background
* Success Criteria
* Constraints
* Design Overview
* Key Design
* Implementation Steps
* Verification
* Risks & Open Questions

Do not add other sections unless requested.

# Workflow

1. Confirm goals, non-goals, success criteria, and constraints.
2. Inspect relevant existing and already-designed mechanisms, then identify the exact unresolved gap.
3. Evaluate options in order: clarify, complete or fix, extend, replace or consolidate, then add. Record why earlier options are insufficient before introducing a new mechanism.
4. Define the minimum mechanism delta: what is reused, changed, removed, and added, including affected files or modules, interactions, and migration or retirement needs.
5. Map success criteria to verification, and identify cumulative complexity, risks, open questions, and decisions requiring confirmation.
