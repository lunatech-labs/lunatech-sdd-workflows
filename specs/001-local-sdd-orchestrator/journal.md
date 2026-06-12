# Journal: Local SDD Orchestrator

Append-only log of decisions, drift, and critic verdicts.

## 2026-06-11 Gate 1

Spec approved by user. Status DRAFT to SPECIFIED. Decisions captured during the interview: agentic tool loop over Ollama tool calling; Ollama only (no remote providers); vendored prompts with provenance headers, plugin treated as upstream; Node 20+/npm/tsx/vitest stack mirroring swarm-kg; per-command y/n confirmation for shell, file tools sandboxed to repo root; unit tests with mocked Ollama plus opt-in live smoke test.

## 2026-06-11 PLAN amendments (user-directed, during planner dispatch)

AC2 amended: planner may fill section 6 and append to section 7; sections 1-5 must remain byte-identical through PLAN, enforced by a containment check in T12. Open question on critic command reuse resolved as no for v1, folded into the future allowlist enhancement.

## 2026-06-11 Gate 2

Plan and 15-task breakdown approved by user. Status SPECIFIED to PLANNED. User committed spec and plan as the git baseline before implementation.

## 2026-06-11 T1 critic verdict: PASS

Scaffold verified independently: npm ci clean, npm test 1 passed, typecheck and build clean, devDeps pinned to swarm-kg versions, zero runtime deps (lockfile scanned for LLM frameworks, none). Deviation accepted by critic: a two-line src/index.ts placeholder, required because tsc fails (TS18003) on an empty src/; T14 owns the real content. Not drift.

## 2026-06-11 T2 critic verdict: PASS

All five vendored files carry provenance headers pinned to spec-swarm@0.1.0 with correct upstream paths; provenance test re-run (8/8), npm test 9/9, typecheck clean. Spot-checks of all five prompts against upstream: adapted, not mangled; registry tool names only; per-role tool subsets match the plan; zero em/en dashes. Notes for later tasks: T7 must align the report tool schema with the prompts' described report contents; src/prompts.ts uses __dirname (CommonJS only), fine under current config.

## 2026-06-11 T3 critic verdict: PASS

Helpers test 12/12, full suite 21/21, typecheck clean, re-run by critic. Mock chat round-trips tool_calls with both object and string arguments forms (T4 dependency confirmed); request recording and temp-repo git states verified behaviorally. Judgment call accepted: opt-in commit flag on temp-repo for T10 fixtures. Critic suggestion to supervisor: commit per task so scope checks can use git diffs instead of mtimes.

## 2026-06-11 T4 critic verdict: PASS

Ollama client verified: 17/17 client tests, 38/38 suite, typecheck clean, re-run by critic. Defensive argument parsing matches the design decision (object or JSON string, malformed flagged not thrown); ping errors actionable (name the URL and suggest ollama serve or config fix); required malformed-arguments and unreachable-port tests are behavioral. Note for T8/T14: only ping has a timeout; chat can wait indefinitely by design (no streaming in v1), so the CLI needs its "model thinking" line.

## 2026-06-11 T5 critic verdict: PASS

Sandbox and file tools verified: 28/28 tool tests, 66/66 suite, typecheck clean, re-run by critic. Security probes passed: sibling-dir bypass blocked (separator-aware prefix check), intermediate symlink escapes caught via realpath of nearest existing ancestor, violations returned as tool errors not throws, AC7 proof asserts real outside filesystem state. Observations only: ? wildcard untested, theoretical TOCTOU window (not required by AC7).

## 2026-06-11 T6 critic verdict: PASS

UI and confirmed run-command verified: 6/6 tool tests, 72/72 suite, typecheck clean, re-run by critic. AC6 behaviors proven: exact command shown before any decision, denial leaves no side-effect file on disk, denial returns the "denied by user" tool error (never a throw), non-zero exits captured without throwing. Shell-exec-by-design ruled justified: input is a whole model-issued command line, per-command human confirmation is the spec's guardrail, allowlists explicitly out of scope.

## 2026-06-12 T7 critic verdict: PASS

Registry and agent loop verified: 19/19 loop tests, 91/91 suite, typecheck clean, re-run by critic. Probes passed: bounded loop with no infinite-spin path even in interview mode, iteration-cap error names role and task, malformed-vs-ordinary-failure distinction holds in code with the T4 malformed flag consumed, denial returns to the model as a tool result and the loop continues, report schemas match all four vendored prompts, per-role subsets enforced at dispatch time not just advertisement. Note for T11: each interview Q&A round consumes one iteration, size maxIterations accordingly.

## 2026-06-12 T8 critic verdict: PASS

Config and model selection verified: 31/31 config tests, 122/122 suite, typecheck clean, re-run by critic. AC8 confirmed: complete config zero-prompt, missing role selects from /api/tags, independent grep for local model names over src/ and prompts/ clean. AC9 confirmed: ping fires before any selection with actionable error. Write-back strictly confirm-gated; capability warning three-way behavior matches the plan. Judgment call accepted: missing base URL uses ui.ask with suggested localhost default (a select is impossible by construction, and an address is not a model name).

## 2026-06-12 T9 critic verdict: PASS

Spec file operations verified: 28/28 tests, 151/151 suite, typecheck clean, re-run by critic. Plan-mandated checks are genuine byte-level assertions. Critic probes beyond the suite: parsed this project's real spec.md (all 15 tasks, colons and parentheses in descriptions survive), findResumableSpecs returned T9 as first unchecked on the live repo, CRLF and trailing-whitespace variants handled. Note for T10: findResumableSpecs silently skips corrupt spec.md files; orient should be aware.

## 2026-06-12 T10 critic verdict: PASS

Git check and orient verified: 10/10 tests, 163/163 suite, typecheck clean, re-run by critic. AC16 proven with real git against temp repos (dirty blocks on decline, clean strictly silent, no-repo and no-commits branches warn and confirm). AC10 proven: resume returns the first unchecked task. Robustness probe: nonexistent dir and missing git binary degrade to warn-and-confirm, fail-safe direction correct. Design note accepted: confirm for one resumable spec, select with explicit fresh option for several. Cosmetic note: missing git binary is reported as "not a git repository".

## 2026-06-12 T11 critic verdict: PASS

SPECIFY and Gate 1 verified: 11/11 tests, 175/175 suite, typecheck clean, re-run by critic. AC1 proven via scripted mock interview (DRAFT until gate, SPECIFIED only after orchestrator-side ui.select approval; model cannot approve its own spec). AC5 abort path asserted at filesystem level (no plan.md, section 6 empty). Design notes accepted: interview iteration cap 100, validation retry cap 3 (conservative, no-hang direction). Notes: vendored template's placeholder task lines may cost weak models one validation retry (relevant to T15); spec_path-outside-repo branch untested directly (sandbox covered at T5); per-task commits would make critic scope checks exact.

## 2026-06-12 T12 critic verdict: PASS

PLAN and Gate 2 verified: 9/9 tests, 185/185 suite, typecheck clean, re-run by critic. AC2 proven: status flips to PLANNED only on the orchestrator approve branch; a planner status edit would trip containment since the protected prefix includes the status line. Containment proven byte-level for sections 1-5 edits and section 7 rewrites (snapshot restored, Gate 2 never offered); pure appends pass. Malformed section 6 fails before Gate 2; the checkbox-count cross-check genuinely catches lines the task regex skips. Notes: failed task-validation leaves the planner's section 6 in place (planner-owned, acceptable); PlanError propagation from re-dispatch is T14's caller concern.

## 2026-06-12 T13 critic verdict: PASS

IMPLEMENT loop verified: 9/9 tests, 195/195 suite, typecheck clean, re-run by critic. AC3 proven: strict section 6 order via re-parse each round, one task per implementer dispatch, critic always after, PASS ticks the right checkbox and journals. AC4 arithmetic confirmed: initial attempt plus exactly 2 retries (6 chat requests in the escalation test), task left unchecked, critic report surfaced. AC12 proven: drift journaled before the user prompt (asserted via journal capture inside the select callback), decision required before anything continues. Design choice accepted: drift-continue re-dispatches the reporting agent. Casts backed by registry report-schema runtime validation.

## 2026-06-12 T14 critic verdict: PASS

PRESENT and CLI wiring verified: 5/5 e2e, 201/201 suite, typecheck clean, re-run by critic. AC14 proven including a direct probe of present.ts statuses (VERIFIED, PARTIALLY VERIFIED, UNVERIFIED, NOT COVERED) and journal-format cross-check against what implement.ts writes. AC5 full: gate rejections proven wire-level (no planner or implementer dispatch ever reaches the model) plus filesystem assertions. AC9 wiring: ping precedes any prompt or dispatch, exit 1 with actionable error. Resume: PLANNED jumps to IMPLEMENT (tested); IN PROGRESS and missing-plan.md guard code-verified. Note: partial/uncovered present branches and IN PROGRESS resume lack dedicated tests (within plan scope); a follow-up present.test.ts would be belt and braces.

## 2026-06-12 T15 critic verdict: PASS

Smoke test and README verified: unflagged npm test 201 passed 1 skipped (no Ollama contact when not opted in), typecheck clean, partial opt-in skips with clear message, real run against devstral:latest re-executed by the critic and passed in 17.6s (read_file then report). UUID token assertion proven non-hallucinable (token never appears in the dispatch context). No hardcoded model names; gating structural via describe.skip; run_command hardwired to deny. README accurate including all three env flags. No prompts/ wording changes were needed: real tool-call parsing worked first try.

## 2026-06-12 All tasks complete

T1-T15 all PASS on first attempt (zero retries, zero drift escalations). Status IN PROGRESS to DONE. Final suite: 201 passed, 1 skipped (opt-in smoke), typecheck clean.
