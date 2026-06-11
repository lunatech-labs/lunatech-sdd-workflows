# Feature Spec: Local SDD Orchestrator (spec-swarm on Ollama)

> Status: SPECIFIED
> Spec folder: specs/001-local-sdd-orchestrator/

## 1. Mission / Why

Run the spec-swarm spec-driven development workflow without Claude Code, against locally hosted Ollama models, so SDD can be used offline, privately, and at zero API cost. The proven role prompts and spec template from the spec-swarm plugin are the starting material; this project gives them a standalone TypeScript harness.

## 2. Outcome

A user can run the orchestrator CLI from any target repo and be taken through SPECIFY, PLAN, IMPLEMENT, and PRESENT with hard human approval gates between phases, exactly like the plugin workflow. Role agents (supervisor/interviewer, planner, implementer, critic) are driven by Ollama models chosen via config or interactive prompt, operate through an agentic tool loop (read/write files, search, run commands), and produce the same artifacts: `specs/NNN-slug/spec.md`, `plan.md`, and `journal.md`.

## 3. Scope

### In scope

- A terminal CLI (Node 20+, TypeScript) invoked from the target repo root that runs the four phases with hard human gates: Gate 1 after SPECIFY (spec approval), Gate 2 after PLAN (plan and task-breakdown approval), per-task progress notes during IMPLEMENT, and a PRESENT summary against the spec. Each gate offers approve, request changes, or abort: request changes at Gate 1 re-enters the interview with the user's feedback; at Gate 2 it re-dispatches the planner with the feedback.
- Git safety check: on startup, warn and require explicit confirmation to proceed if the target repo has no git history or a dirty working tree.
- Phase 0 orient: on startup, detect existing `specs/*/spec.md` with unchecked tasks and offer to resume from the first unchecked task, or start fresh.
- An agentic tool loop over the Ollama chat API with tool calling. Core tools: read file, write file, list/glob, grep/search, run command, and a finish/report call that ends the agent's turn with a structured result.
- Tool-loop guards: a max-iterations cap per agent dispatch (clear error naming the task), and malformed tool calls returned to the model as tool errors with a small retry cap before the dispatch fails.
- Tool sandboxing: file tools are confined to the target repo (paths resolving outside the repo root are rejected). Every run-command tool call is printed and requires per-command y/n human confirmation; denial is returned to the model as a tool error, not a crash.
- Model selection that is never hardcoded: a config file defines the Ollama base URL and a model per role; any missing value triggers an interactive prompt listing the models installed on the local Ollama instance. Best-effort warning when a selected model does not advertise tool-calling support.
- Vendored copies of the plugin's role prompts (supervisor skill, planner, implementer, critic) and the spec template, each starting with a provenance comment (e.g. "vendored from spec-swarm@0.1.0 - upstream: agents/sdd-planner.md"). The plugin is upstream; re-syncs are deliberate. Adapting wording for local models is expected, not drift to avoid.
- The implement loop from the plugin: one task per implementer dispatch, critic verification per task, max 2 retries on critic FAIL then escalate to the human, checkbox ticking in spec.md, append-only journal.md, and the drift rule (agent-reported spec/plan problems stop the loop and go to the human).
- Vitest unit tests against a mocked Ollama server (reusing swarm-kg's mock-server plus temp-dir pattern), and an opt-in end-to-end smoke test against a real local model, auto-skipped when Ollama is unreachable. The smoke test exists specifically to validate real tool-call parsing.

### Out of scope

- Remote or hosted LLM providers of any kind (Anthropic API, OpenAI-compatible endpoints, etc.). Locally hosted Ollama only.
- Runtime loading of prompts or the template from the plugin path, and any shared package for prompts/template. Vendored copies only.
- Command allowlist config and any auto-approval of shell commands (future enhancement: allowlist of trusted prefixes promotable from confirmed commands, including letting the critic reuse commands the user already approved for the implementer).
- Web UI or TUI dashboard; plain terminal prompts only.
- Bun support; Node 20+/npm/tsx only, mirroring swarm-kg's stack.
- Parallel task execution; tasks run strictly sequentially (`depends_on` is recorded but not used for scheduling).
- Session resume mid-task; if the process dies mid-task, that task restarts from its beginning. Only task-level resume via Phase 0 is supported.
- Context compaction or long-run memory; if a model's context overflows, the task fails with a clear error.

## 4. Constraints & Decisions

- Language / runtime: TypeScript on Node 20+, npm, tsx for dev execution, vitest for tests (same toolchain as swarm-kg: typescript 5.x, tsx 4.x, vitest 4.x).
- Keep runtime dependencies minimal: Ollama via plain fetch against its HTTP API, terminal interaction via node:readline (or equally minimal), no LLM framework dependencies.
- Artifact layout and lifecycle identical to the plugin: `specs/NNN-slug/spec.md` (sections 1-7, statuses DRAFT through DONE), `plan.md` written by the planner, append-only `journal.md`. The vendored template is the source of truth for spec structure.
- The SPECIFY interview is conducted by a supervisor agent (vendored and adapted from the plugin's SKILL.md) chatting with the user in the terminal; the human gates themselves are plain CLI confirmations handled by the orchestrator, never by the model.
- Role agents only ever see their vendored prompt plus the dispatch context (spec path, plan path, task ID, prior feedback), matching the plugin's dispatch contract.
- Approval gates are hard stops enforced by orchestrator code: no later-phase file writes can occur before the gate is approved.

## 5. Acceptance Criteria (how you'll verify it)

- [ ] AC1: Given a target repo with no specs, when the user runs the CLI and completes the SPECIFY interview, then `specs/001-<slug>/spec.md` exists with sections 1-5 filled, section 6 empty, and Status DRAFT, and the CLI stops at Gate 1 awaiting explicit approval; on Gate 1 approval the Status transitions to SPECIFIED.
- [ ] AC2: Given an approved spec, when PLAN runs, then the planner agent writes `plan.md` and fills only section 6 and appends to section 7 of spec.md, and the CLI presents the approach and task list and stops at Gate 2; on Gate 2 approval the Status transitions to PLANNED.
- [ ] AC3: Given an approved plan with N tasks, when IMPLEMENT runs, then tasks execute strictly sequentially, each as implementer dispatch followed by critic dispatch, and a critic PASS ticks the task checkbox in spec.md and appends the verdict to journal.md.
- [ ] AC4 (retries): When the critic returns FAIL, the implementer is re-dispatched with the critic's specific failures at most 2 times for that task; after the second failed retry the CLI stops and shows the critic's report to the user.
- [ ] AC5 (hard gates): When the user rejects at Gate 1 or Gate 2, no later-phase artifacts are produced (no plan.md or section 6 before Gate 1 approval; no implementation file changes before Gate 2 approval).
- [ ] AC6 (command guardrail): When an agent issues a run-command tool call, the command is displayed and nothing executes until the user confirms; on denial the model receives a "denied by user" tool result and the agent loop continues.
- [ ] AC7 (sandbox): When an agent attempts a file read or write that resolves outside the target repo root (e.g. via ../ or an absolute path), the tool call is rejected with an error result and no file outside the repo is touched.
- [ ] AC8 (no hardcoded models): Given a config file specifying per-role models, those models are used; given no config or a missing role entry, the CLI lists models fetched from the local Ollama API and prompts the user to choose. No model name appears in source code.
- [ ] AC9 (Ollama unreachable): When the Ollama API is unreachable at startup, the CLI exits with a clear, actionable error before any interview or agent dispatch begins.
- [ ] AC10 (resume): Given an existing spec with unchecked tasks, when the CLI starts, it offers to resume that spec and, on acceptance, continues from the first unchecked task.
- [ ] AC11 (tests): `npm test` passes with no Ollama instance running (mocked server); the smoke test runs only when explicitly opted in (env flag) and Ollama is reachable, otherwise it is skipped, not failed.
- [ ] AC12 (drift rule): When the implementer or critic reports that the spec or plan is wrong or incomplete, the loop stops, the report is appended to journal.md, and the CLI asks the user for a decision before anything continues.
- [ ] AC13 (provenance): Every vendored prompt and template file begins with a provenance comment naming the upstream plugin version and file path.
- [ ] AC14 (present): When all tasks are checked or the user stops early, the CLI outputs each acceptance criterion with its verification status, plus any drift recorded in journal.md.
- [ ] AC15 (loop guard): When an agent exceeds the max-iterations cap or repeatedly emits malformed tool calls, the dispatch fails with a clear error naming the task; the orchestrator does not hang.
- [ ] AC16 (git check): Given a target repo with uncommitted changes or no git repo, the CLI warns and proceeds only on explicit confirmation.

## 6. Task Breakdown

<!-- Filled in by sdd-planner, approved by the user at Gate 2.
     Each task: testable in isolation, ~30-60 min of agent work,
     maps to at least one acceptance criterion. -->

1. [ ] T1: Project scaffold: package.json, strict tsconfig, vitest, npm scripts, sanity test - verifies: AC11 - depends_on: none
2. [ ] T2: Vendor role prompts and spec template with provenance headers, prompt loader, provenance test - verifies: AC13 - depends_on: T1
3. [ ] T3: Test helpers: scriptable mock Ollama server (tags, show, chat with tool_calls) and temp-repo fixtures - verifies: AC11 - depends_on: T1
4. [ ] T4: Ollama fetch client: chat with tools, listModels, showCapabilities, ping with actionable errors - verifies: AC9 - depends_on: T3
5. [ ] T5: Path sandbox (repo-root confinement) and file tools: read, write, list, search - verifies: AC7 - depends_on: T3
6. [ ] T6: Terminal UI (ask, confirm, select via node:readline) and confirmed run-command tool with denial-as-tool-error - verifies: AC6 - depends_on: T1
7. [ ] T7: Tool registry with per-role subsets and agent loop with max-iterations and malformed-call guards - verifies: AC15, AC6 - depends_on: T4, T5, T6
8. [ ] T8: Config loading, interactive model selection from /api/tags, capability warning, no-hardcoded-models scan, startup reachability error - verifies: AC8, AC9 - depends_on: T4, T6
9. [ ] T9: Spec file operations: NNN-slug numbering, status transitions, task parsing, checkbox ticking, section edits with sections 1-5 protection, append-only journal, resume scan - verifies: AC3, AC10 - depends_on: T3
10. [ ] T10: Git safety check (dirty tree or no history requires confirmation) and Phase 0 orient with resume offer - verifies: AC16, AC10 - depends_on: T6, T9
11. [ ] T11: SPECIFY phase: supervisor interview loop, spec validation, Gate 1 approve/changes/abort, DRAFT to SPECIFIED - verifies: AC1, AC5 - depends_on: T2, T7, T9
12. [ ] T12: PLAN phase: planner dispatch, containment check (sections 1-5 byte-identical, section 7 append-only), Gate 2, SPECIFIED to PLANNED - verifies: AC2, AC5 - depends_on: T2, T7, T9
13. [ ] T13: IMPLEMENT loop: per-task implementer then critic dispatches, tick and journal on PASS, max 2 retries on FAIL then escalate, drift rule halt - verifies: AC3, AC4, AC12 - depends_on: T2, T7, T9
14. [ ] T14: PRESENT phase and CLI entry wiring: full phase machine, AC verification summary, drift report, end-to-end mocked test including gate-rejection branches - verifies: AC14, AC5 - depends_on: T8, T10, T11, T12, T13
15. [ ] T15: Opt-in real-Ollama smoke test: env-flag gated, auto-skipped when unreachable, validates real tool-call parsing - verifies: AC11 - depends_on: T7, T8

## 7. Open Questions

- How much adaptation will the vendored prompts need for smaller local models (shorter prompts, more explicit tool instructions)? To be assessed during PLAN against the models actually installed (devstral, gpt-oss:20b, llama3.3, glm-4.7-flash).
- (Resolved) Critic command reuse: no, v1 confirms every command; the critic-reuse idea is folded into the future allowlist enhancement noted in out of scope.
- (Resolved) Planner section ownership: the planner may fill section 6 and append to section 7; sections 1-5 remain protected and must stay byte-identical through PLAN. AC2 updated at Gate 2 to reflect this.
