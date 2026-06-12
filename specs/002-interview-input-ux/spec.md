# Feature Spec: Interview Input UX Fixes

> Status: SPECIFIED
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

## 7. Open Questions

- None at specification time. Defects and fixes were observed directly in live testing.
