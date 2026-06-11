# Plan: Local SDD Orchestrator (spec-swarm on Ollama)

> Spec: specs/001-local-sdd-orchestrator/spec.md
> Status: proposed (Gate 2 pending)

## Technical approach

- **Layered design, orchestrator owns control flow.** A thin CLI entry (`src/index.ts`) runs a phase state machine: startup checks (Ollama reachable, git safety), Phase 0 orient, then SPECIFY, PLAN, IMPLEMENT, PRESENT. All gates, retries, status transitions, and checkbox ticking are orchestrator code in `src/phases/*`; models never control flow.
- **One generic agent loop, four role configurations.** `src/agent-loop.ts` drives any role: system prompt = vendored role prompt from `prompts/`, first user message = dispatch context (spec path, plan path, task ID, feedback). Loop: POST `/api/chat` (stream false, `tools` array), execute returned `tool_calls` through a tool registry, append `role: "tool"` results (with `tool_name`), repeat until the agent calls the `report` finish tool. Guards: max-iterations cap, malformed-call retry cap. Two modes: interview mode (assistant text without tool calls is shown to the user and the readline reply becomes the next user message, used by the supervisor in SPECIFY) and worker mode (text without tool calls gets a corrective nudge that counts toward the cap, used by planner, implementer, critic).
- **Minimal tool surface, per-role subsets.** Registry tools: `read_file`, `write_file`, `list_files` (glob), `search_files` (regex grep), `run_command`, `report`. File tools resolve paths against the target repo root and reject anything escaping it (realpath plus prefix check). `run_command` prints the command and blocks on y/n confirmation; denial returns a "denied by user" tool error. Mirroring upstream, the critic gets no `write_file`; the supervisor gets no `run_command`.
- **Ollama client is plain fetch** (`src/ollama.ts`): `chat` (with tools), `listModels` (GET /api/tags), `showModel` (POST /api/show, read `capabilities` for a best-effort "tools" check), `ping` for the startup reachability gate. No LLM framework, no streaming in v1.
- **Spec artifacts via a dedicated module** (`src/spec-files.ts`): next `NNN-slug` allocation, status line transitions (DRAFT through DONE), section 6 task parsing (checkbox, ID, `verifies:`, `depends_on:`), checkbox ticking, replace-section-6-only edits with sections 1 to 5 protected by snapshot and restore, append-only `journal.md` writes, and unchecked-task detection for resume.
- **Config, never hardcoded models.** `sdd.config.json` at the target repo root: `{ "ollamaBaseUrl": "...", "models": { "supervisor": "...", "planner": "...", "implementer": "...", "critic": "..." } }`. Any missing value triggers an interactive picker fed by `/api/tags`. A vitest test greps `src/` and `prompts/` for the locally installed model names to keep AC8 honest.
- **Toolchain mirrors swarm-kg**: typescript 5.x, @types/node 20.x, tsx 4.x, vitest 4.x, npm, strict tsconfig, `tests/` outside `rootDir`. Tests reuse swarm-kg's two patterns: an `http.createServer` mock Ollama that returns scripted responses, and `fs.mkdtemp` temp dirs as throwaway target repos.

## Repository layout

```
sdd-local/
├── package.json / tsconfig.json / .gitignore
├── sdd.config.example.json
├── prompts/                      # vendored from spec-swarm@0.1.0, provenance headers
│   ├── supervisor.md             # from skills/spec-swarm/SKILL.md (interview portions adapted)
│   ├── planner.md                # from agents/sdd-planner.md
│   ├── implementer.md            # from agents/sdd-implementer.md
│   ├── critic.md                 # from agents/sdd-critic.md
│   └── templates/spec.md         # from skills/spec-swarm/templates/spec.md
├── src/
│   ├── index.ts                  # CLI entry + phase state machine
│   ├── config.ts                 # config load + interactive model selection
│   ├── ollama.ts                 # fetch client: chat/tags/show/ping
│   ├── ui.ts                     # node:readline ask / confirm / select
│   ├── agent-loop.ts             # generic agentic loop + guards
│   ├── spec-files.ts             # spec.md + journal.md operations
│   ├── git-check.ts              # git safety check
│   ├── tools/
│   │   ├── sandbox.ts            # repo-root path confinement
│   │   ├── fs-tools.ts           # read/write/list/search
│   │   ├── run-command.ts        # confirmed shell execution
│   │   └── registry.ts           # schemas + dispatch + per-role subsets
│   └── phases/
│       ├── orient.ts             # Phase 0 resume detection
│       ├── specify.ts            # interview + Gate 1
│       ├── plan.ts               # planner dispatch + Gate 2
│       ├── implement.ts          # implementer/critic loop
│       └── present.ts            # AC summary + drift report
└── tests/
    ├── helpers/mock-ollama.ts    # scriptable mock server (tool_calls aware)
    ├── helpers/temp-repo.ts      # mkdtemp target-repo fixtures
    ├── *.test.ts                 # unit tests per module
    └── smoke.test.ts             # opt-in real-Ollama smoke test
```

## Key design decisions

- **Ollama API shape** (verified against current docs): tools are OpenAI-style `{type: "function", function: {name, description, parameters}}`; the response message carries `tool_calls: [{function: {name, arguments}}]` where `arguments` is a JSON object, not a string. Parse defensively anyway: accept an object, or `JSON.parse` a string, since model behavior varies. Tool results go back as `{role: "tool", tool_name, content}`.
- **Gate enforcement is structural.** `specify.ts` returns only after Gate 1 approval; `plan.ts` is not even called before that return, so no plan.md or section 6 can exist pre-approval. Same between Gate 2 and `implement.ts`. Tests assert the absence of later-phase artifacts after a rejection.
- **Planner containment (resolved at Gate 2).** Before the planner dispatch the orchestrator snapshots spec.md; afterwards it verifies sections 1 to 5 are byte-identical to the Gate 1 version (restoring the snapshot and failing the dispatch if not). The planner may replace section 6 and append to section 7 only: the pre-dispatch section 7 content must be preserved verbatim, with new entries added after it. Any other change is a containment violation.
- **Interview channel.** The supervisor prompt is adapted so the model knows: plain assistant text is shown to the user as the next interview question, `write_file` is how it saves spec.md from the vendored template, and `report` ends the interview with the spec path. The Gate 1 confirmation itself is readline code, never the model.
- **Implement loop state** lives in spec.md (checkboxes) and journal.md only; no extra state file. That is what makes Phase 0 task-level resume trivial.
- **Capability warning** reads `capabilities` from /api/show and warns when `"tools"` is absent; older Ollama versions may omit the field entirely, so absence of the field warns as "could not verify" rather than blocking.

## Per-task detail

### T1: Project scaffold
- **Files**: `package.json`, `tsconfig.json`, `.gitignore`, `tests/sanity.test.ts`.
- **Approach**: Mirror swarm-kg's toolchain pinning (typescript 5.9.x, tsx 4.x, vitest 4.x, @types/node 20.x). Scripts: `dev` (tsx src/index.ts), `typecheck` (tsc --noEmit), `test` (vitest run), `build`. Strict tsconfig with `rootDir: src`, tests excluded. One trivial sanity test so `npm test` is green from day one. No runtime dependencies.
- **Critic verify**: `npm install && npm test && npm run typecheck` succeed with no Ollama running; `package.json` has no LLM framework deps.

### T2: Vendor prompts and template with provenance
- **Files**: `prompts/supervisor.md`, `prompts/planner.md`, `prompts/implementer.md`, `prompts/critic.md`, `prompts/templates/spec.md`, `tests/provenance.test.ts`, `src/prompts.ts` (loader).
- **Approach**: Copy from the upstream plugin (version 0.1.0 per its plugin.json). Each file starts with an HTML comment, e.g. `<!-- vendored from spec-swarm@0.1.0 - upstream: agents/sdd-planner.md -->`. Adapt for local models and the new harness: strip Claude-plugin frontmatter and tool names (Read/Glob/Grep become the registry tool names), make tool usage instructions explicit and imperative for smaller models, and rewrite the supervisor's dispatch language (it no longer "spawns" agents; the orchestrator does). Loader reads prompts relative to the package, not the target repo. Test walks `prompts/` and asserts every file begins with a provenance comment naming version and upstream path.
- **Critic verify**: `npx vitest run tests/provenance.test.ts`; spot-check one prompt against upstream for adapted-not-mangled content (AC13).

### T3: Test helpers: mock Ollama server and temp repos
- **Files**: `tests/helpers/mock-ollama.ts`, `tests/helpers/temp-repo.ts`, `tests/helpers.test.ts`.
- **Approach**: Extend swarm-kg's mock pattern: an `http.Server` on port 0 that serves GET /api/tags (configurable model list), POST /api/show (configurable capabilities), and POST /api/chat replaying a script of canned assistant messages (text and/or `tool_calls`), while recording every request body for assertions. Script entries can match on role-prompt markers so different agents get different replies. `temp-repo.ts` wraps `fs.mkdtemp` with optional `git init` and seeded files, plus cleanup.
- **Critic verify**: `npx vitest run tests/helpers.test.ts` proving scripted tool_calls round-trip and request recording.

### T4: Ollama client
- **Files**: `src/ollama.ts`, `tests/ollama.test.ts`.
- **Approach**: `chat(baseUrl, model, messages, tools)` POSTing stream:false and returning the assistant message (content plus normalized tool_calls; arguments accepted as object or JSON string); `listModels` via /api/tags; `showCapabilities` via /api/show; `ping` returning a clear actionable error string when unreachable (connection refused, timeout, non-2xx). Types for ChatMessage including the `tool` role with `tool_name`.
- **Critic verify**: `npx vitest run tests/ollama.test.ts` against the T3 mock, including a malformed-arguments case and an unreachable-port case.

### T5: Sandbox and file tools
- **Files**: `src/tools/sandbox.ts`, `src/tools/fs-tools.ts`, `tests/fs-tools.test.ts`.
- **Approach**: `resolveInRepo(repoRoot, p)` resolves and rejects any path (relative `../`, absolute, symlink-escaped via realpath of the nearest existing ancestor) outside the root, throwing a typed SandboxError. Tools return `{ok, output}` or `{ok: false, error}` shapes for the registry: read (with size cap), write (mkdir -p parents), list (glob via `fs` walk, no new deps), search (regex over files, capped matches).
- **Critic verify**: `npx vitest run tests/fs-tools.test.ts`; must include `../` escape, absolute-path escape, and proof no file outside the temp repo was touched (AC7).

### T6: Terminal UI and confirmed run-command tool
- **Files**: `src/ui.ts`, `src/tools/run-command.ts`, `tests/run-command.test.ts`.
- **Approach**: `ui.ts` wraps node:readline/promises: `ask(question)`, `confirm(question)` (y/n), `select(label, options)` (numbered list). All UI functions are injected as an interface so tests substitute scripted answers. `run-command` prints the exact command, calls the injected confirm, executes via `child_process` with cwd = repo root and captured stdout/stderr/exit code on approval, and returns a "denied by user" tool error (not a throw) on denial.
- **Critic verify**: `npx vitest run tests/run-command.test.ts`: denial returns an error result and executes nothing (assert via a side-effect file the command would have created); approval returns output (AC6).

### T7: Tool registry and agent loop with guards
- **Files**: `src/tools/registry.ts`, `src/agent-loop.ts`, `tests/agent-loop.test.ts`.
- **Approach**: Registry holds JSON-schema definitions for the six tools and dispatches calls; per-role subsets (critic without write_file, supervisor without run_command). `runAgent({role, systemPrompt, context, tools, mode, maxIterations})` implements the loop described in the approach: execute tool_calls in order, `report` ends the dispatch with its structured arguments, unknown tool or unparseable arguments return a tool-error message with a per-dispatch malformed-call cap (e.g. 3) before failing, and exceeding maxIterations throws an error naming the role and task. Interview mode routes plain text through the injected UI; worker mode nudges once per occurrence.
- **Critic verify**: `npx vitest run tests/agent-loop.test.ts` with T3 scripts: happy path (tool call then report), malformed-call retry then fail, iteration-cap fail with task name in the message, denial-continues-loop (AC15, AC6 integration).

### T8: Config and model selection
- **Files**: `src/config.ts`, `tests/config.test.ts`, `sdd.config.example.json`.
- **Approach**: Load `sdd.config.json` from the target repo root; validate shape. For each missing role model (or missing base URL), use injected UI `select` over `listModels` results; warn via `showCapabilities` when "tools" is absent or unverifiable. Resolved config is passed down, never persisted silently (offer to write the completed config back, on confirm). Startup order in the eventual CLI: ping first, exit with actionable error if unreachable, before any interview. Include a guard test that scans `src/` and `prompts/` for known local model names (devstral, gpt-oss, llama3, glm-4) to enforce no hardcoding.
- **Critic verify**: `npx vitest run tests/config.test.ts`: config honored, missing entry triggers selection from mock /api/tags, unreachable Ollama produces a clear error, hardcoded-name scan passes (AC8, AC9).

### T9: Spec file operations
- **Files**: `src/spec-files.ts`, `tests/spec-files.test.ts`.
- **Approach**: Pure-ish functions over the vendored template structure: `nextSpecDir(specsRoot, slug)` (001, 002, ...), `readStatus`/`writeStatus` for the `> Status:` line, `parseTasks` (checkbox state, ID, verifies, depends_on), `tickTask`, `replaceSection6`, `assertSections1to5Unchanged(before, after)`, `assertSection7AppendOnly(before, after)` (prior section 7 content preserved verbatim, new entries only after it), `appendJournal` (append-only, timestamped entries), `findResumableSpecs` (any spec.md with unchecked section 6 tasks). All operate on supplied paths so temp-repo tests are direct.
- **Critic verify**: `npx vitest run tests/spec-files.test.ts`, including: ticking one task leaves the rest byte-identical, section 6 replacement does not alter sections 1 to 5, journal appends never truncate.

### T10: Git safety check and Phase 0 orient
- **Files**: `src/git-check.ts`, `src/phases/orient.ts`, `tests/orient.test.ts`.
- **Approach**: `git-check` runs `git status --porcelain` and `git rev-parse HEAD` in the target repo: no repo, no commits, or dirty tree produce a warning and require injected `confirm` to proceed (decline exits cleanly). `orient` calls `findResumableSpecs`; if any, offers resume (returning the spec path and first unchecked task) or fresh start.
- **Critic verify**: `npx vitest run tests/orient.test.ts` over temp repos: dirty tree blocks without confirmation, clean repo passes silently, repo with unchecked tasks offers resume and returns the first unchecked task (AC16, AC10).

### T11: SPECIFY phase and Gate 1
- **Files**: `src/phases/specify.ts`, `tests/specify.test.ts`.
- **Approach**: Dispatch the supervisor prompt in interview mode with file tools sandboxed to the target repo and the vendored template content available (the dispatch context includes the template path inside the package, exposed read-only through a dedicated context block rather than the sandbox). On report, validate the produced spec.md: sections 1 to 5 non-empty, section 6 empty, Status DRAFT; re-prompt the supervisor with validation errors if not. Gate 1 via injected UI: approve (status to SPECIFIED, return spec path), request changes (re-enter interview mode with the user's feedback appended), abort (exit, no further writes).
- **Critic verify**: `npx vitest run tests/specify.test.ts` with a scripted interview: produces a valid DRAFT spec, approval flips status, rejection leaves no plan.md and section 6 empty (AC1, AC5 part).

### T12: PLAN phase and Gate 2
- **Files**: `src/phases/plan.ts`, `tests/plan.test.ts`.
- **Approach**: Worker-mode dispatch of the planner prompt with context: spec path, repo root, prior Gate 2 feedback if any. After report: assert plan.md exists, assert sections 1 to 5 byte-identical to the Gate 1 version and section 7 changed only by appending (prior content preserved verbatim); restore the snapshot and surface a dispatch failure if violated. Parse section 6 tasks and check each has `verifies:` and `depends_on:`. Present approach summary and task list, then Gate 2: approve (status PLANNED), request changes (re-dispatch with feedback), abort.
- **Critic verify**: `npx vitest run tests/plan.test.ts`: scripted planner writes plan.md and section 6, status transitions on approval, rejection then re-dispatch carries feedback, no implementation files exist pre-approval (AC2, AC5 part).

### T13: IMPLEMENT loop
- **Files**: `src/phases/implement.ts`, `tests/implement.test.ts`.
- **Approach**: Set status IN PROGRESS. For each unchecked task in order: implementer worker dispatch (spec path, plan path, single task ID, critic feedback when retrying), then critic worker dispatch (same refs plus the implementer's report). PASS: tick checkbox, append verdict to journal.md, one-line progress note. FAIL: re-dispatch implementer with the critic's specific failures, max 2 retries, then stop and show the critic's report. DRIFT from either agent: append to journal.md, stop, ask the user (continue, amend, or abort) before anything else runs. Between-task pause is a safe stop (resume re-enters via Phase 0).
- **Critic verify**: `npx vitest run tests/implement.test.ts` with scripted verdicts: PASS path ticks and journals, FAIL-FAIL-FAIL escalates after exactly 2 retries, DRIFT halts the loop and journals before the user prompt (AC3, AC4, AC12).

### T14: PRESENT phase and CLI entry wiring
- **Files**: `src/phases/present.ts`, `src/index.ts`, `tests/e2e.test.ts`.
- **Approach**: `present.ts` reads spec.md and journal.md: print each acceptance criterion with its verification status derived from task checkboxes and journal verdicts, list recorded drift, set status DONE when all tasks are checked. `index.ts` wires the full machine: ping, git check, orient, then the four phases with gates, passing one shared injected UI so the whole flow is scriptable. The e2e test runs the complete machine against scripted mock conversations in a temp repo, including a Gate 1 rejection branch asserting no later-phase artifacts.
- **Critic verify**: `npx vitest run tests/e2e.test.ts` (full mocked run start to PRESENT) plus `npm test` green overall (AC14, AC5 full).

### T15: Opt-in real-Ollama smoke test
- **Files**: `tests/smoke.test.ts`, README note.
- **Approach**: Guarded by `SDD_SMOKE=1` and a live `ping`; otherwise `describe.skip` so it skips, never fails. Reads the model from `SDD_SMOKE_MODEL` env (no hardcoded names). The test performs one real worker dispatch through the agent loop with the real tool registry in a temp repo: prompt the model to read a seeded file and call `report` with its content, validating real tool-call parsing end to end. Feed findings about prompt phrasing for local models back into `prompts/` wording if parsing is unreliable.
- **Critic verify**: `npm test` with no env flag and no Ollama: smoke reported as skipped, suite green. With `SDD_SMOKE=1` and a local model: smoke passes (AC11).

## Risks and pitfalls

- **Small-model tool discipline.** Local models (especially below ~20B) emit prose instead of tool calls, hallucinate tool names, or return arguments as strings. Mitigations are built in: worker-mode nudge, malformed-call retry cap, defensive argument parsing, explicit imperative tool instructions added during T2 prompt adaptation, and T15 validating against real models. Expect prompt iteration here.
- **Capability detection is genuinely best effort.** /api/show `capabilities` includes "tools" on current Ollama but the field is absent on older servers; the warning must distinguish "no tool support" from "could not verify".
- **Context overflow.** Long implement dispatches can exceed a local model's context; Ollama may silently truncate rather than error. Per scope this fails the task with a clear error; detect via degenerate behavior (iteration cap) rather than promising true overflow detection. Worth a journal note when it happens.
- **No streaming means silent waits.** stream:false on a 20B local model can pause for tens of seconds; print a per-dispatch spinner or "model thinking" line so the CLI does not look hung.
- **Sandbox symlink escapes.** Plain `path.resolve` prefix checks are bypassable via symlinks; T5 must realpath the nearest existing ancestor before the prefix check.
- **Section ownership (resolved).** The planner fills section 6 and appends to section 7; sections 1 to 5 are protected byte-identical. AC2 was updated at Gate 2 to say "fills only section 6 and appends to section 7". The containment check in T12 enforces exactly this, including section 7 append-only.
- **Upstream sync discipline.** Vendored prompts will diverge deliberately; the provenance header plus the pinned version (0.1.0) is the only sync anchor. Keep adaptations as small commits so future re-syncs can be diffed.
