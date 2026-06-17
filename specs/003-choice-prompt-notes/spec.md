# Feature Spec: Choice prompt with attachable notes

> Status: IN PROGRESS
> Spec folder: specs/003-choice-prompt-notes/

## 1. Mission / Why

The orchestrator's gates and confirms currently take a bare option (a number,
or y/n) with no way to record *why*. When a user approves with a caveat, or
requests changes, that reasoning is lost or has to be re-typed at a separate
follow-up prompt. A Claude-Code-style choice prompt lets the user pick an
option, optionally attach a free-text note explaining the choice, or escape to
a free-text response, and have that note captured in journal.md alongside the
decision. This makes the audit trail in journal.md richer and the interaction
feel like the rest of the tooling.

## 2. Outcome

At every workflow confirmation and gate (the y/n confirms and the four
numbered gates: Gate 1 spec approval, Gate 2 plan approval, the IMPLEMENT drift
decision, the git-safety confirm), the user sees a numbered menu. They can:

- type a number to pick that option;
- type a number followed by free text to pick that option AND attach a note;
- pick a final "Something else…" option that opens a free-text response.

The caller receives the chosen option plus any note. Where a gate journals its
decision, the attached note is written to journal.md too.

## 3. Scope

### In scope

- `src/ui.ts`: a choice-prompt primitive that returns the chosen option plus an
  optional free-text note, supports an inline note after the option number,
  and includes a final "Something else…" option that opens a free-text
  response. Invalid input re-prompts.
- Adapting `UI.confirm` so the y/n confirms (git-safety, and any other confirm
  call site) go through the choice prompt and can carry a note.
- Wiring the existing gate `select` call sites — Gate 1 (`specify.ts`), Gate 2
  (`plan.ts`), the IMPLEMENT drift decision (`implement.ts`) — to receive the
  option plus note.
- Recording an attached note in journal.md wherever the gate already journals
  (drift gate), and adding a journal write for an attached note at Gate 1 and
  Gate 2 (which do not journal today).
- At Gate 1 / Gate 2, when the user attaches a note to a choice, that note is
  used as the "Request changes" feedback in place of the separate follow-up
  question (the follow-up still runs when no note is attached).

### Out of scope

- The `readAnswer` interview input — already implemented (spec 002).
- A TUI / colour redesign, arrow-key navigation, or any rendering overhaul
  beyond the numbered-menu + note text flow.
- Changing what any gate decides: the option sets and their meanings stay
  exactly as they are (Approve / Request changes / Abort; Continue / Amend /
  Abort; yes/no), and no gate branch logic changes.
- Adding notes to non-gate `select` call sites that are setup rather than
  workflow gates (config model picker, orient resume picker) — they must keep
  working but are not required to expose notes.
- Multi-line paste safety for the choice prompt and the "Something else..."
  free-text response. The free-text response uses the single-line `askRaw`
  reader; making all gate prompts paste-safe is deferred to the planned
  bracketed-paste input reader (future work). See Open Questions Q2.

## 4. Constraints & Decisions

- Language: TypeScript, Node.js, over `node:readline/promises`. Match the
  existing `createReadlineUI` style and the injected-`UI` test seam (scripted
  answers, no TTY).
- Keep the existing option-set constants and their string values unchanged:
  `GATE1_APPROVE` / `GATE1_REQUEST_CHANGES` / `GATE1_ABORT`,
  `GATE2_APPROVE` / `GATE2_REQUEST_CHANGES` / `GATE2_ABORT`,
  `DRIFT_CONTINUE` / `DRIFT_AMEND` / `DRIFT_ABORT`.
- Existing gate branch logic (the `if (choice === GATE1_APPROVE)` chains, the
  drift `continue|amend|abort` mapping) stays unchanged in behaviour.
- Input syntax: a bare number selects with no note; a number followed by
  free text (e.g. `1 needs more tests`) selects that option and attaches the
  rest of the line as the note. "Something else…" is the final menu item and
  opens a free-text prompt whose text becomes the returned response.
- Journaling uses the existing `appendJournal` helper and the existing
  journal.md format; the drift gate already journals via it.
- The `UI` interface change must be backward-compatible enough that the
  non-gate `select`/`confirm` call sites (config, orient) keep working without
  behaviour change.
- No new third-party dependencies.

## 5. Acceptance Criteria (how you'll verify it)

- [ ] AC1: Given a choice prompt with options, when the user types a valid
  option number with no trailing text, then the prompt returns that option and
  no note.
- [ ] AC2: Given a choice prompt, when the user types a valid option number
  followed by free text, then the prompt returns that option AND the trailing
  text as the note.
- [ ] AC3: Given a choice prompt, when the user selects the final
  "Something else…" option, then a free-text prompt opens and the entered text
  is returned as the free-text response (distinguishable from the predefined
  options).
- [ ] AC4: Given a choice prompt, when the user types input that is not a valid
  option number and not the "Something else…" selector (e.g. `0`, `9`, `abc`,
  empty), then the prompt re-prompts rather than returning.
- [ ] AC5: Given the IMPLEMENT drift gate (which journals), when the user picks
  an option with an attached note, then the note is written to journal.md at
  the point the gate already journals, and the existing
  continue/amend/abort decision is unchanged.
- [ ] AC6: Given Gate 1 (spec approval), when the user picks an option with an
  attached note, then a journal.md entry recording the note is written, and the
  gate's approve/request-changes/abort branch behaviour is unchanged.
- [ ] AC7: Given Gate 2 (plan approval), when the user picks an option with an
  attached note, then a journal.md entry recording the note is written, and the
  gate's branch behaviour is unchanged.
- [ ] AC8: Given Gate 1 / Gate 2 "Request changes", when the user attached a
  note to that choice, then the note is used as the change feedback and the
  separate follow-up question is NOT asked; when no note was attached, the
  follow-up question still runs.
- [ ] AC9: Given the git-safety confirm (a y/n confirm), when the user
  responds through the choice prompt, then a "yes" proceeds and a "no" declines
  exactly as before, and any attached note is available to the caller. The
  Yes/No menu accepts `y`/`n` and `yes`/`no` as aliases for the two options (so
  the prior confirm input still works), still with optional-note support
  (e.g. `y rebuild first`).
- [ ] AC10: The existing non-gate call sites (config model picker, orient
  resume picker) continue to return the chosen option as before, with no
  behaviour change.

## 6. Task Breakdown

1. [x] T1: Add a failing `tests/ui.test.ts` group for `createReadlineUI.choose` covering: bare number returns `{ option }` with no note (AC1), number plus trailing text returns `{ option, note }` (AC2), the final "Something else..." item opens a free-text prompt and returns `{ freeText }` distinguishable from a predefined option (AC3), and invalid input (`0`, past-last-number, `abc`, empty) re-prompts then accepts a valid choice (AC4). Use the existing PassThrough harness. The tests fail because `choose` does not yet exist. - verifies: AC1, AC2, AC3, AC4 - depends_on: none
2. [x] T2: Implement `ChoiceResult`, the `SOMETHING_ELSE` constant, and `choose(label, options)` in `src/ui.ts` (interface plus `createReadlineUI`), and a shared private menu/parse helper, so the T1 tests pass. Leave `ask`, `confirm`, `select`, `readAnswer` signatures and behaviour unchanged. - verifies: AC1, AC2, AC3, AC4 - depends_on: T1
3. [ ] T3: Add `confirmWithNote(question): Promise<{ yes; note? }>` to the `UI` interface and `createReadlineUI`, implemented over the `choose` helper as a Yes/No menu. The menu also accepts `y`/`n` and `yes`/`no` (case-insensitive) as aliases for the two options, still with optional-note support (e.g. `y rebuild first` -> `{ yes: true, note: 'rebuild first' }`). `tests/ui.test.ts` cases: yes, no, a yes-with-note, and an alias case asserting `y` -> yes and `n` -> no; assert plain `confirm` still returns a boolean unchanged. - verifies: AC9 - depends_on: T2
4. [ ] T4: Migrate `gitSafetyCheck` in `src/git-check.ts` to take the note-aware confirm and return the boolean from `{ yes }` (note available to the caller), update the `src/index.ts` call site, and update `tests/orient.test.ts` so yes proceeds and no declines exactly as before. - verifies: AC9 - depends_on: T3
5. [ ] T5: Wire the IMPLEMENT drift gate (`handleDrift` in `src/phases/implement.ts`) to `ui.choose`, mapping `result.option` to continue/amend/abort unchanged, and fold an attached note into the existing decision `appendJournal` entry. Update `tests/implement.test.ts` `scriptedUI` to provide `choose`; add a case asserting a note is journaled at the existing journal point and the decision is unchanged. - verifies: AC5 - depends_on: T2
6. [ ] T6: Wire Gate 1 (`src/phases/specify.ts` ~line 282) to `ui.choose`, branching on `result.option` unchanged; when a note (or free text) is attached, write a new `journal.md` entry via `appendJournal` to the spec folder. Update `tests/specify.test.ts` `scriptedUI` with `choose`; assert the note is journaled and approve/abort/request-changes branch behaviour is unchanged. - verifies: AC6 - depends_on: T2
7. [ ] T7: Wire Gate 2 (`src/phases/plan.ts` ~line 269) to `ui.choose`, branching on `result.option` unchanged; when a note (or free text) is attached, write a new `journal.md` entry via `appendJournal` to the spec folder. Update `tests/plan.test.ts` `scriptedUI` with `choose`; assert the note is journaled and branch behaviour is unchanged. - verifies: AC7 - depends_on: T2
8. [ ] T8: At Gate 1 and Gate 2 request-changes branches, use the attached note as the change feedback in place of the `FEEDBACK_QUESTION` follow-up when a note is present, and keep running `ui.ask(FEEDBACK_QUESTION)` when no note is attached. Add tests in `tests/specify.test.ts` and `tests/plan.test.ts` for both paths (note present: follow-up NOT asked; note absent: follow-up asked). - verifies: AC8 - depends_on: T6, T7
9. [ ] T9: Regression sweep: confirm `src/config.ts` and `src/phases/orient.ts` still call `ui.select` / `ui.confirm` with no behaviour change, the e2e flow runs (`tests/e2e.test.ts` `scriptedUI` updated with `choose`/`confirmWithNote` only as needed to keep gates driving), and run the full test suite plus typecheck/lint. - verifies: AC10 - depends_on: T4, T5, T8

<!-- Filled in by sdd-planner, approved by the user at Gate 2. -->

## 7. Open Questions

- None outstanding. The three design decisions (note replaces follow-up at
  Gate 1/2; add a journal write for notes at Gate 1/2; inline note after the
  option number) were resolved with the user during the interview.

Resolved at Gate 2 (2026-06-16):

- Q1 RESOLVED: trailing text after the "Something else..." option number (e.g.
  `4 my own answer`) is used directly as the free-text response; the second
  prompt is skipped.
- Q2 RESOLVED: the "Something else..." free-text prompt uses the single-line
  `askRaw` reader, consistent with the rest of the gate input layer. NOT the
  multi-line `readAnswer` reader.
  - Known limitation: a multi-line paste into this free-text prompt is not
    paste-safe (only the first line is read). This is deliberately deferred to
    the planned bracketed-paste input reader, which will make all gate prompts
    paste-safe uniformly. See Out of scope.
- Q3 RESOLVED: an attached note at Gate 1 / Gate 2 is journaled on ANY branch
  (approve, request-changes, abort) when a note is present.
