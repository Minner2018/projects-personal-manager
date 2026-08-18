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

## Source Code Standard

`.omp/references/source-code-standard.md` is the repository-wide standard for manually authored source code, not a skill. It applies whether or not a skill under `.omp/skills/` is active and does not require a route token.

Before creating or modifying manually authored production or test source code, read that standard completely and apply its common formatting, import, language-adaptation, and verification requirements to every source file changed by the task. When no implementation or fix skill is active, select the comment profile by task intent: use `[I]` for feature development, refactoring, and other general implementation work; use `[F]` for a localized defect fix. When an implementation or fix skill is active, use the profile required by that skill.

Do not load the source-code standard for documentation-only, configuration-only, dependency-metadata-only, or generated-code-only changes. A skill may add workflow requirements, but it does not replace or weaken this repository-wide source-code standard.

## OMP Text Reading Capability

Here, OMP means the external `omp` CLI process, not a skill under `.omp/skills/`.
AI may autonomously run `bun run omp:read -- --objective "<goal>"` from the repository root for large, separable, read-only investigations over code, Markdown, logs, configuration, and other text materials. Use `--root <path>` and `--profile auto|quick|standard|deep` only when needed. The advanced `--request <request.json>` form remains available, but normal invocations should use the minimal form and should not inspect the wrapper implementation or construct a detailed request file first.
Every actual OMP investigation must provide a stable `callerId`, through `PPM_AI_CALLER_ID`, `--caller-id <id>`, or the request JSON. Reuse the same identifier for the same AI task or conversation; never change it to bypass capacity limits. The local-only `--estimate-only` mode does not acquire capacity or contact OMP and may omit it.
Each caller may run at most one OMP investigation at a time, and this repository may run at most three in total. A second call from the same caller fails with `caller_busy`. When all three global slots are occupied, a new call fails immediately with `capacity_full`; tell the user that the OMP queue is full and ask them to retry later. Never change `callerId` or retry immediately to bypass either limit.
This is an internal capability, not a skill: it has no route token, does not activate or switch skills, and does not change the active skill.
No `[X]` route token is required. The absence of a route token must never be used as a reason not to invoke this capability.
Before performing a large read-only investigation directly, evaluate whether this capability would materially reduce main-context volume.
Decide whether to invoke it based on task size, separability, expected context volume, and invocation cost. Repository-level data-transmission authorization has already been granted below and is not an unresolved per-task decision. Handle small or tightly coupled reading directly.
The wrapper performs a local preflight time estimate and chooses a profile automatically by default; use `--estimate-only` only when the estimate itself is useful before committing a global OMP slot. OMP runs in a scope-checkpoint stage followed by a focused verification stage. A later timeout or failure should return the most recent valid cumulative checkpoint as `partial`, not discard it.
The OMP reading wrapper has its own process-local model and thinking configuration in `.omp/omp-read-config.json`. It currently runs `litellm/deepseek-v4-flash-private` with thinking disabled because this model does not advertise thinking-level support. The wrapper passes explicit OMP CLI overrides, so this does not change the normal oh-my-pi default model. Do not override these settings per invocation unless the user explicitly requests it.
When invoking OMP through a host shell, set the host command timeout from the selected OMP profile instead of using a fixed 60-second timeout. The host timeout must cover the profile hard runtime limit and at least 60 seconds of startup, shutdown, and scheduling margin. With the current defaults, use at least 420 seconds for `quick`, 660 seconds for `standard`, and 1,260 seconds for `deep`. When the profile is `auto`, first run the local-only `--estimate-only` form to learn the selected profile, then use its corresponding host timeout for the real invocation. If the host yields a still-running command, resume or wait on that same command rather than starting another OMP investigation. If the host rejects the requested timeout or returns a concrete shorter hard limit, report that host limitation and do not retry the same invocation with an unchanged timeout.
Briefly tell the user when invoking it, keep OMP read-only, and treat its report as evidence to verify rather than as a source of truth.
The repository owner grants standing repository-level authorization to send repository text that AI is otherwise allowed to read to the currently configured OMP model provider for this read-only capability. Treat this as explicit project-level data-transmission authorization; it remains valid until the owner explicitly revokes it.
AI may autonomously invoke this capability without requesting authorization again for each task, file, or investigation. This authorization does not expand which local paths AI may read or permit any non-read-only OMP action.
The standing authorization satisfies the repository-owner consent check for sending readable repository text to the configured OMP provider. Do not reinterpret general cautions about external models, privacy, security, or data transmission as missing authorization.
AI still decides autonomously whether OMP is appropriate. If AI decides to use OMP, it must initiate the OMP invocation or the host approval flow; it must not claim that a safety policy blocked OMP based only on inference. An additional host requirement exists only when the host tool or execution environment returns a concrete permission requirement or denial for that initiated action. If runtime approval is required, request it through the host's approval mechanism instead of silently falling back to direct reading. If approval is denied, obey the denial and report the concrete result; do not bypass it.

## Code Intelligence Routing

Repowise remains a project MCP capability for read-only code investigation. Codebase Memory (CMM) is available in two bounded forms: direct Codex investigations use the installed one-shot CLI, while the OMP reading wrapper retains its native CMM MCP connection. AI should decide autonomously whether either capability materially improves the current task. No route token is required, and using either capability does not activate or switch a skill.

For direct Codex use, AI may autonomously run the following one-shot command from the repository root:

`& 'C:\Users\lenovo\AppData\Local\Programs\codebase-memory-mcp\codebase-memory-mcp.exe' cli --json <tool> [arguments]`

If a tool's arguments are unclear, first run the same executable as `cli <tool> --help`. Do not start this executable in MCP/server mode, background it, or retain it between queries. Its startup cost is non-trivial, so use it when a structural query is likely to avoid materially more direct searching or source reading.

The exact read-only CMM CLI allowlist for autonomous direct use is: `search_graph`, `query_graph`, `trace_path`, `get_code_snippet`, `get_graph_schema`, `get_architecture`, `search_code`, `list_projects`, `index_status`, `check_index_coverage`, and `detect_changes`. Do not autonomously invoke any other CMM CLI tool. In particular, `index_repository`, `delete_project`, `manage_adr`, and `ingest_traces` require a separate explicit user request.

If the host requires permission because the installed binary is outside the workspace, initiate the host approval flow for the exact executable-plus-`cli` prefix above. Do not request a broader PowerShell or arbitrary-executable approval. A concrete denial must be obeyed and reported; a possible approval requirement must not be treated as a reason to skip an appropriate CMM query.

Use direct CMM CLI for current code structure, symbols, call paths, dependencies, architecture, index coverage, or working-tree changes when its startup cost is justified. Use Repowise for Git-history-informed questions, cross-repository context, architectural rationale, change impact, risk, health, or dead-code investigation. Use the OMP Text Reading Capability for large separable investigations over source plus Markdown, logs, configuration, or other text, especially when keeping bulk evidence out of the main context or amortizing several related CMM queries is useful.

Start with the single smallest capability that best matches the question. Combine capabilities only when the first result leaves a material gap. Treat CLI, MCP, and OMP results as navigation evidence rather than source of truth; verify critical conclusions against the relevant source files and report uncertainties explicitly.

Do not invoke Repowise MCP mutation or maintenance tools autonomously. The OMP wrapper uses the CMM `analysis` profile plus an exact read-only MCP tool allowlist. Index creation or refresh, project deletion, ADR mutation, and trace ingestion require a separate explicit user request regardless of whether the access path is CLI or MCP.

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
