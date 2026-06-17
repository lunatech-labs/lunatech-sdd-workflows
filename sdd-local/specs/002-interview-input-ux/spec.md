# Feature Spec: Interview Input UX Fixes

> Status: DONE
> Spec folder: specs/002-interview-input-ux/

## 1. Mission / Why

Interview mode's input handling broke a live manual run against devstral. Three defects: (1) no visible input marker: the model's question is passed as the readline prompt string (agent-loop.ts around line 130, ui.ask(text)), so the cursor sits flush against model text and the user cannot tell a wait from a hang; (2) rl.question reads one line, so multi-line pastes shred: later lines queue as answers to later questions, progressively desyncing the interview; (3) tool calls emit no output, so tool-using steps are indistinguishable from hangs.

## 2. Outcome

A user can paste a multi-line answer and have it arrive as one message, always sees a clear marker when input is expected, and sees what tools agents invoke.

## 3. Scope

### In scope

- ui.ts: a multi-line answer method for interview use: print the model's message as output (blank line above), then a "you> " marker; continuation lines marked "...> "; an empty line submits; the joined lines (trailing blank trimmed) are returned as one string. ask/confirm/select unchanged.
- agent-loop.ts interview mode: print model text, then read via the new method; the model's text is never used as the prompt string.
- agent-loop.ts all modes: emit a progress line per tool call via onProgress: "[role] -> <tool_name> <arg summary>" (file tools: the path; run_command: the command; summaries truncated to about 80 chars; report included).
- Tests for each, following the existing scripted-UI and mock-server patterns.

### Out of scope

- $EDITOR escape for composing answers (recorded as a future enhancement).
- Colors or TUI of any kind.
- Streaming.
- Worker-mode nudge changes.
- Readline history.
- Changes to vendored prompts.

## 4. Constraints & Decisions

- node:readline only, no new runtime dependencies.
- UI stays an injected interface: extend it, and update existing test stubs accordingly.
- The existing 201 tests stay green.

## 5. Acceptance Criteria (how you'll verify it)

- [ ] AC1: Given interview mode, when the model replies with plain text, the text prints followed by a "you> " marker on a fresh line.
- [ ] AC2: Given a 5-line paste then an empty line, the answer arrives as ONE user message containing all 5 lines verbatim; no residual queued input answers a later prompt.
- [ ] AC3: Given any tool call in any mode, onProgress receives "[role] -> <tool> <summary>"; run_command summaries show the command, file tools the path.
- [ ] AC4: npm test green including all pre-existing tests; typecheck clean.

## 6. Task Breakdown

<!-- Filled in by the planner, approved by the user at Gate 2.
     Each task: testable in isolation, ~30-60 min of agent work,
     maps to at least one acceptance criterion. -->

1. [x] T1: Add UI.readAnswer (multi-line input with "you> "/"...> " markers, empty line submits, one readline interface per answer) to src/ui.ts; create tests/ui.test.ts covering markers, verbatim 5-line paste, and no residual input; add a readAnswer stub to every scripted UI in tests so typecheck stays clean - verifies: AC1, AC2 - depends_on: none
2. [x] T2: Switch agent-loop interview mode from ui.ask(text) to ui.readAnswer(text) so model text is printed output, never the prompt string; update interview tests in tests/agent-loop.test.ts and tests/specify.test.ts, asserting a multi-line answer arrives as one user message - verifies: AC1, AC2 - depends_on: T1
3. [x] T3: Emit "[role] -> <tool> <summary>" via onProgress for every tool call in all modes: add summarizeToolCall to src/tools/registry.ts (file tools: path; run_command: command; 80-char truncation; report included) with unit tests, wire into src/agent-loop.ts, and update progress assertions in tests/agent-loop.test.ts - verifies: AC3 - depends_on: none
4. [x] T4: Full regression sweep: npm test green including all pre-existing tests, npm run typecheck clean; fix only breakage introduced by T1-T3 - verifies: AC4 - depends_on: T1, T2, T3

## 7. Open Questions

- None at specification time. Defects and fixes were observed directly in live testing.
