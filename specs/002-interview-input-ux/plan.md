# Plan: Interview Input UX Fixes

> Spec: specs/002-interview-input-ux/spec.md
> Status: PLANNED (pending Gate 2)

## Technical approach

- Extend the injected `UI` interface (src/ui.ts) with one new method,
  `readAnswer(message: string): Promise<string>`: it writes a blank line,
  the model's message, then reads lines with a `you> ` marker (continuation
  lines `...> `) until an empty line submits. Lines are kept verbatim and
  joined with `\n`; the terminating empty line is dropped. `ask`, `confirm`,
  and `select` are untouched.
- Implement `readAnswer` in `createReadlineUI` with ONE readline interface
  held open for the whole answer. This is the actual fix for paste shredding:
  the current per-question pattern (fresh interface per `rl.question`, closed
  in `finally`) lets pasted lines buffered in stdin leak into later prompts
  or get dropped. A single interface consumes the whole paste, line by line,
  inside one `readAnswer` call.
- In src/agent-loop.ts interview mode, replace `ui.ask(text)` (line 130)
  with `ui.readAnswer(text)`. The model's text becomes printed output inside
  `readAnswer`, never the readline prompt string. No other loop behavior
  changes.
- Add an exported `summarizeToolCall(name, args)` helper to
  src/tools/registry.ts (the module that already knows every tool and its
  argument shapes): file tools summarize to `args.path`, list_files /
  search_files to `args.pattern`, run_command to `args.command`, report to
  an empty summary (the line still prints). Newlines collapse to spaces and
  the summary truncates to 80 chars with a trailing `...`. It never throws
  on missing or odd args (malformed calls reach the loop too).
- In src/agent-loop.ts, emit `onProgress("[<role>] -> <tool> <summary>")`
  for every entry of `reply.toolCalls`, in all modes, before the call is
  validated or executed. This reuses the existing injected `onProgress`
  channel (stderr by default, no-op in tests).
- `UI` gains a required method, so every scripted stub must add it in the
  same task that changes the interface, or typecheck breaks. Stubs live in:
  tests/agent-loop.test.ts, tests/specify.test.ts, tests/e2e.test.ts,
  tests/config.test.ts, tests/orient.test.ts, tests/implement.test.ts,
  tests/plan.test.ts, tests/smoke.test.ts. Pattern to follow: queue-backed
  answer list plus a recorded-calls array, throwing when unscripted, exactly
  like the existing `ask`/`confirm`/`select` stubs.

## Per-task detail

### T1: UI.readAnswer plus stub updates

- Create: tests/ui.test.ts (first test file for src/ui.ts; drive
  `createReadlineUI` with `node:stream` PassThrough streams, the standard
  no-TTY readline testing pattern).
- Modify: src/ui.ts (interface and `createReadlineUI`); the eight test files
  above (add a `readAnswer` stub member to each ScriptedUI; throwing when
  unscripted is fine everywhere except where T2 scripts answers).
- Approach: implement `readAnswer` as described. Tests to write:
  - typed flow: message printed with a blank line above, `you> ` marker
    appears in output on its own line after the message (AC1 at UI level).
  - 5-line paste: pre-write `l1\nl2\nl3\nl4\nl5\n\n` into the input stream,
    call `readAnswer` once, expect the five lines back verbatim as one
    string; then confirm a subsequent `ask` call gets fresh input, not
    residue (AC2 at UI level).
  - continuation marker: second and later prompts use `...> `.
  - empty first line returns the empty string.
  - `ask`/`confirm`/`select` behavior unchanged (one regression test each
    is enough; they had no direct tests before).
- Verify: `npx vitest run tests/ui.test.ts` green; `npm run typecheck` clean
  (proves every stub was updated).

### T2: agent-loop interview mode reads via readAnswer

- Modify: src/agent-loop.ts (interview branch only); tests/agent-loop.test.ts
  (scriptedUI gains a `readAnswers` queue and a `readAnswered: string[]`
  record; the two interview tests move from `asks` to it); tests/specify.test.ts
  (the interview answer 'Testing the SPECIFY phase.' moves from the `asks`
  queue to the `readAnswers` queue; the opening 'Describe the feature'
  question stays on `ask`). tests/e2e.test.ts scripts its supervisor to
  report without a plain-text turn, so its stub just throws.
- Approach: one-line swap in the interview branch; update the doc comment
  at the top of agent-loop.ts (it describes the interview path). Add an
  agent-loop test asserting that a multi-line `readAnswer` return arrives
  as ONE user message in the next chat request and that the model's text
  was passed to `readAnswer`, not `ask` (AC1, AC2 at loop level).
- Verify: `npx vitest run tests/agent-loop.test.ts tests/specify.test.ts
  tests/e2e.test.ts` green.

### T3: per-tool-call progress lines

- Modify: src/tools/registry.ts (export `summarizeToolCall`),
  src/agent-loop.ts (emit the line per tool call), tests/agent-loop.test.ts
  (progress assertions).
- Approach: unit-test the summarizer directly in the existing 'tool
  registry' describe block (path for file tools, command for run_command,
  80-char truncation, newline collapsing, empty/missing args do not throw).
  Then loop tests: capture `onProgress` lines and assert
  `[implementer] -> run_command <command>` and `[implementer] -> read_file
  <path>` appear, and that a report call produces a line too. Note the
  existing happy-path test asserts `progress` has length 2 (one thinking
  line per chat call); it gains tool-call lines and must be updated to
  match the new counts.
- Verify: `npx vitest run tests/agent-loop.test.ts` green.
- Independent of T1/T2: touches neither the UI interface nor the interview
  branch.

### T4: full regression and typecheck

- Modify: nothing new expected; this task exists to catch interactions
  (e.g. a stub missed in a test file, progress-line count drift in suites
  that capture onProgress).
- Approach: run the full suite and typecheck; fix only breakage introduced
  by T1-T3, no scope additions.
- Verify: `npm test` fully green (all pre-existing tests plus new ones);
  `npm run typecheck` clean (AC4).

## Risks & pitfalls

- The single-readline-interface requirement in `readAnswer` is load-bearing:
  reverting to the per-question pattern silently reintroduces defect 2 and
  only the paste test catches it. Keep that test.
- `ask` trims its answer; `readAnswer` must NOT trim individual lines (AC2
  says verbatim). Only the terminating empty line is dropped.
- Adding a required interface method breaks typecheck across eight test
  files at once; T1 must land the stub updates atomically or nothing
  compiles.
- specify.test.ts interleaves phase-level `ask` calls (opening question,
  Gate 1 feedback) with interview turns; moving only the interview answers
  to the new queue and leaving the rest on `ask` is easy to get wrong:
  check `ui.asked` / recorded `readAnswer` calls in assertions, not just
  counts.
- agent-loop tests assert exact progress-line counts today; T3 changes the
  counts in any test whose script includes tool calls and captures progress.
- Malformed tool calls (unparseable JSON arguments) still appear in
  `reply.toolCalls` with whatever the client salvaged; the summarizer and
  the progress emission must tolerate empty names and missing args.
- Decision (not blocking): the report tool's progress line prints with an
  empty summary, just `[role] -> report`. The spec requires report be
  included but names no summary field; keeping it empty avoids leaking
  long report bodies into progress output.
