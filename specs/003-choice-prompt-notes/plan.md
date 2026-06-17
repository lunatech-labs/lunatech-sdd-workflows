# Plan: Choice prompt with attachable notes

Spec: specs/003-choice-prompt-notes/spec.md
Status of this plan: proposed (awaiting Gate 2)

## Technical approach

- Add two note-aware primitives to the `UI` interface in `src/ui.ts`, leaving
  the existing `select` and `confirm` signatures byte-for-byte unchanged so the
  non-gate call sites (config model picker, orient resume picker) and their
  scripted test fakes keep working untouched (AC10):
  - `choose(label, options): Promise<ChoiceResult>` where
    `ChoiceResult = { option: string; note?: string } | { freeText: string }`.
    It renders the numbered menu plus a final "Something else..." item, parses
    "bare number" vs "number + trailing text" vs the free-text escape, and
    re-prompts on anything invalid.
  - `confirmWithNote(question): Promise<{ yes: boolean; note?: string }>`,
    implemented on top of `choose` over a fixed two-option Yes/No menu so a y/n
    confirm can also carry a note. The menu additionally accepts `y`/`n` and
    `yes`/`no` (case-insensitive) as aliases for the two options, so the prior
    `confirm` input still works (AC9 "exactly as before"); note support is
    preserved (e.g. `y rebuild first`). The plain `confirm` stays as the simple
    boolean path for callers that do not want a note.
- The shared parsing/menu logic lives in one private helper inside
  `createReadlineUI` (e.g. `choosePrompt`). `choose` and `confirmWithNote` both
  call it; this keeps the "bare number / number+note / Something else..."
  grammar defined in exactly one place. The `y`/`n`/`yes`/`no` aliases are a
  `confirmWithNote`-only concern: resolve them to the matching option number
  before/within the prompt so the generic `choose` grammar stays numeric-only
  (the generic menu has no Yes/No aliases). The free-text escape reuses the
  existing single-line `askRaw` reader (the menu is single-line input, not the
  multi-line `readAnswer` paste reader).
- The three gate call sites switch from `ui.select(...)` to `ui.choose(...)`
  and branch on `result.option` exactly as today; the existing
  `if (choice === GATE1_APPROVE)` style chains are preserved by reading
  `result.option` into the same `choice` variable. Option-set constants and
  their string values are unchanged (constraint 4). A returned `freeText`
  branch maps to "treat the free text as the note on whatever the gate's
  request-changes / continue path is"; see per-task detail and Open Questions.
- Journaling reuses the existing `appendJournal(journalPath, entry)` helper and
  the existing journal.md block format. The drift gate already journals, so its
  note is folded into the existing `appendJournal` call. Gate 1 and Gate 2 gain
  a new `appendJournal` call (guarded so it only fires when a note is present),
  writing to `journal.md` in the same folder as the spec, matching how
  `implement.ts` derives `journalPath = path.join(path.dirname(specPath),
  'journal.md')`.
- At Gate 1 / Gate 2, an attached note REPLACES the separate
  `FEEDBACK_QUESTION` follow-up: on the request-changes branch, if a note is
  present it is used as the feedback string; if not, the existing
  `ui.ask(FEEDBACK_QUESTION)` runs as before (AC8).
- No new third-party dependencies; everything stays on
  `node:readline/promises` and the existing colour palette.

## New / changed UI API

In `src/ui.ts`:

```
export type ChoiceResult =
  | { option: string; note?: string }
  | { freeText: string };

export interface UI {
  ask(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;          // unchanged
  select(label: string, options: string[]): Promise<string>;  // unchanged
  readAnswer(message: string): Promise<string>;          // unchanged
  // new:
  choose(label: string, options: string[]): Promise<ChoiceResult>;
  confirmWithNote(question: string): Promise<{ yes: boolean; note?: string }>;
}
```

Input grammar parsed by `choose` (constraint, decision 1 and 4):
- `2` -> `{ option: options[1] }` (bare number, no note).
- `2 needs more tests` -> `{ option: options[1], note: 'needs more tests' }`
  (rest of line after the number, trimmed, is the note).
- The final menu item is the literal "Something else..." selector; choosing it
  (by its number, with no trailing text) opens a single free-text prompt whose
  entered text is returned as `{ freeText }`. If the user types a note after the
  "Something else..." number, treat the trailing text itself as the free text
  and skip the second prompt (see Open Question Q1).
- Anything else (`0`, a number past the last option, `abc`, empty) re-prompts
  (AC4). Note that "Something else..." occupies the last slot, so the valid
  numeric range is `1..options.length + 1`.

Free-text label of the "Something else..." item is a new exported constant in
`src/ui.ts` (e.g. `SOMETHING_ELSE`) so gates and tests share the wording.

## Wiring per call site

- `src/phases/specify.ts` Gate 1 (~line 282): replace `ui.select(...)` with
  `ui.choose(...)`. Read `result.option` into `choice`. After the branch
  decision, if a note (or free text) is present, `appendJournal` it. On the
  request-changes branch, use the note as `feedback` when present, else
  `ui.ask(FEEDBACK_QUESTION)`. `journalPath` derived from `specPath`.
- `src/phases/plan.ts` Gate 2 (~line 269): same shape as Gate 1, against the
  `GATE2_*` constants and the plan's `FEEDBACK_QUESTION`.
- `src/phases/implement.ts` drift gate (`handleDrift`, ~lines 215-235): replace
  `ui.select(...)` with `ui.choose(...)`. The gate already calls
  `appendJournal` for the report and the decision; when a note is present,
  include it in (or add it alongside) the existing decision journal entry. The
  continue/amend/abort mapping reads `result.option` and is otherwise
  unchanged.
- `src/git-check.ts` `gitSafetyCheck`: it currently takes `UI['confirm']`.
  Change it to take `UI['confirmWithNote']` (or the whole `ui`) and return the
  boolean from `{ yes }`; the note is surfaced to the caller per AC9. The
  `src/index.ts:70` call site updates from `(question) => ui.confirm(question)`
  to the note-aware method. Behaviour for yes/no is unchanged.
- `src/config.ts` and `src/phases/orient.ts`: NO change. They keep calling
  `ui.select` / `ui.confirm`. This is the AC10 guard.

## Test seam

Tests inject a scripted fake `UI`. Several phase tests define their own local
`scriptedUI` returning `Promise<string>` from `select`; those fakes must gain a
`choose` (and, where confirm is exercised, `confirmWithNote`) implementation, or
the gate code must be driven through `choose`. Plan: each migrated gate test's
local `scriptedUI` gets a scripted `choose` returning a `ChoiceResult`, mirroring
the existing `selects` array but as `chooses`. The `createReadlineUI` behaviour
is covered directly in `tests/ui.test.ts` with the in-memory `PassThrough`
harness (the established pattern), exercising bare-number, number+note, free-text
escape, and re-prompt cases.

## Risks & pitfalls

- The biggest risk is breaking the per-phase `scriptedUI` fakes. They are
  duplicated across `tests/specify.test.ts`, `tests/plan.test.ts`,
  `tests/implement.test.ts`, and `tests/e2e.test.ts`, each returning a bare
  string from `select`. Migrating gates to `choose` means each of those fakes
  needs a `choose` method. This is mechanical but spread across files; the task
  breakdown isolates it per gate so a failure is localized.
- `gitSafetyCheck` is currently typed against `UI['confirm']` and tested in
  `tests/orient.test.ts` by passing `ui.confirm` directly. Changing its
  parameter type ripples into that test and the `src/index.ts:70` call site.
  Kept as its own task with AC9.
- Off-by-one in the menu: "Something else..." is appended as the last option, so
  valid numbers run `1..options.length + 1`. The re-prompt boundary (AC4) must
  reject `options.length + 2` and `0`.
- Empty-note ambiguity: a number followed only by whitespace must be treated as
  a bare selection (no note), not an empty-string note. The parser trims and
  treats empty as absent.
- The colour palette is only active on a TTY; tests drive in-memory streams, so
  assertions must not depend on ANSI codes (the existing tests already avoid
  this).
- Do not route the free-text escape through `readAnswer` (the multi-line paste
  reader) unless the spec intends multi-line free-text responses. The spec says
  "a free-text prompt"; single-line via `askRaw` is the minimal, faithful
  reading. Flagged as Q2.
