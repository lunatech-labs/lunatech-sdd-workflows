
## 2026-06-16 — T1 critic verdict: PASS

T1 (failing tests for `choose`) verified by critic. 6 new tests in
tests/ui.test.ts pin AC1–AC4, fail with `ui.choose is not a function` (expected
test-first failure); 11 existing ui.test.ts tests and full suite (221 passed,
1 skipped) otherwise green. tsc --noEmit exits 0.

Notes (non-blocking): pre-existing uncommitted readAnswer change in src/ui.ts
predates this spec and is unrelated; a vacuous assertion at ui.test.ts:132 is
harmless.

## 2026-06-16 — T2 critic verdict: PASS

T2 (implement `choose` + `ChoiceResult` + `SOMETHING_ELSE` + shared `choosePrompt`
helper in src/ui.ts) verified by critic. 6 T1 choose tests now pass; full suite
227 passed, 1 pre-existing skip; tsc --noEmit clean. Empty-note omits the key,
free-text path uses single-line askRaw (not readAnswer), choose is numeric-only
(y/n aliases deferred to T3), select/confirm bytes unchanged. SOMETHING_ELSE =
"Something else...".

## 2026-06-17 — T3 critic verdict: PASS (accepted on merits)

T3 (confirmWithNote over the shared choosePrompt helper, with case-insensitive
y/n / yes/no aliases and optional-note support) is implementation-correct and
fully verified: 23 ui.test.ts tests pass, full suite 233 passed / 1 pre-existing
skip, tsc --noEmit clean. Critic independently confirmed: alias logic confined
to confirmWithNote via a resolveAlias resolver, does NOT leak into the generic
`choose` (bare `y` re-prompts in choose); aliases case-insensitive; word-boundary
regex rejects `yesterday`; number+note grammar carries through; plain `confirm`
still returns a boolean; empty note omits the key. Tests are non-tautological.

The critic returned a literal FAIL, but its sole cited cause was a pre-existing
uncommitted spec-002 readAnswer marker change that was dirty in the working tree
BEFORE this spec began (visible in the session-start git status as `M src/ui.ts`
/ `M tests/ui.test.ts`). No T1/T2/T3 implementer authored it; they only added the
choose/confirmWithNote surface. This is a working-tree hygiene artifact, NOT a
T3 defect and NOT spec drift. Supervisor surfaced it to the user; the user
committed the tree (commit 3b475ca: "spec 003 T1-T3: choose + confirmWithNote;
input-UX continuation label"), clearing the only blocker. T3 accepted as PASS on
the now-clean baseline. Continuing to T4.

## 2026-06-17 — T4 critic verdict: PASS

T4 (migrate gitSafetyCheck to UI['confirmWithNote'], update index.ts:70 and
tests/orient.test.ts) verified by critic. gitSafetyCheck now takes the
note-aware confirm and returns `.yes`; clean-repo path still returns true
without calling confirm (proven: clean-repo test asserts 0 calls); describeGitState
untouched; decline still triggers the clean-exit branch. orient.test.ts exercises
proceed + decline + yes-with-note (non-tautological). No other gate/config/orient
call sites touched. tests/orient.test.ts 11 passed; full suite 234 passed / 1
pre-existing skip; tsc --noEmit clean.

Cosmetic (not a defect): the git-check.ts doc comment says the note is
"available to the caller" though the function returns only the boolean — within
the plan's explicit allowance (return the boolean; note destination not invented
since there is no startup journal).

## 2026-06-17 — T5 critic verdict: PASS (accepted on merits)

T5 (wire drift gate handleDrift to ui.choose; fold note into the existing
user-decision journal entry) is implementation-correct and fully verified by the
critic: decision mapping byte-identical (choice = result.option; the
continue/amend/abort ternary unchanged), no silent fall-through (freeText branch
re-prompts, never assigns a fourth/empty decision; `let choice` assigned on every
exit path), note folded into the SAME existing entry as
`...: user decision on the drift: ${decision}\n\nNote: ${note}` with no new
appendJournal call, DRIFT-reported entry unchanged. AC5 test drives full
implement() and asserts both the note string at the decision entry AND the
unchanged decision (non-tautological). tests/implement.test.ts 10 passed; full
suite 235 passed / 1 pre-existing skip; tsc --noEmit clean.

Critic returned a literal FAIL, but both cited reasons were artifacts of an
incorrect premise that each task is committed/isolated individually:
  1. "Out-of-scope T4 files in the tree" — git-check.ts/index.ts/orient.test.ts
     are T4, completed AFTER the T1–T3 commit (3b475ca) and not yet committed.
     The spec-swarm workflow does NOT commit per task, so accumulated uncommitted
     T4+T5 work is expected. Supervisor verified `git diff --name-only HEAD`
     shows ONLY T4 (git-check, index) + T5 (implement) production files, no stray
     edits or scope creep.
  2. "T5 checkbox not ticked / no T5 journal entry" — bookkeeping happens AFTER
     the critic passes; the critic inspected mid-flight state. Now recorded here.
Neither is a T5 defect or spec drift. T5 accepted as PASS.

Non-blocking follow-up (deferred to T9): add a test exercising the drift
freeText re-prompt path (user picks "Something else..." → loops, no fourth
decision). The freeText handling is implemented and reasoned but currently
untested.

## 2026-06-17 — T6 critic verdict: PASS

T6 (wire Gate 1 in specify.ts from ui.select to ui.choose; new appendJournal
note entry on any branch per Q3) verified by critic. result.option -> choice;
approve/abort/request-changes branches byte-identical; GATE1_* constants
unchanged; writeStatus('SPECIFIED') on approve unchanged; request-changes still
runs ui.ask(FEEDBACK_QUESTION) (note-replaces-feedback deferred to T8). freeText
re-prompts carrying a pending note (mirrors T5), no silent fall-through. New
guarded appendJournal write `Gate 1 (relPath): user chose "..." with note: ...`
to spec-folder journal.md. tests/specify.test.ts 14 passed (5 migrated + new
approve/abort/request-changes-with-note tests, non-tautological — they read
journal.md and assert the status flip); tsc clean.

KNOWN/EXPECTED, not a defect: tests/e2e.test.ts 3 tests now fail with
`ui.choose is not a function` at specify.ts:292 (Gate 1 choose call) because the
e2e local scriptedUI fake has no `choose` method. This is the planned cross-task
ripple assigned to T9 (update e2e/phase fakes). Implementer correctly did not
touch e2e per T6 scope. Full suite: 235 passed, 1 skip, 3 expected e2e fails.

## 2026-06-17 — T7 critic verdict: PASS

T7 (wire Gate 2 in plan.ts from ui.select to ui.choose; new appendJournal note
entry on any branch per Q3 — the exact analogue of T6) verified by critic.
Branch logic confirmed byte-identical to HEAD: approve -> writeStatus('PLANNED')
/ approved, abort -> aborted, else request-changes still runs
`feedback = await ui.ask(FEEDBACK_QUESTION)` (note-replaces-feedback deferred to
T8). GATE2_* constants and gateLabel unchanged. freeText carried as pending note
+ re-prompt (mirrors T6/T5), no fall-through. Guarded appendJournal write
`Gate 2 (planRelPath): user chose "..." with note: ...`. tests/plan.test.ts 12
passed (migrated + approve/abort/request-changes-with-note tests reading
journal.md, non-tautological); tsc clean. Full suite 238 passed, 1 skip, only the
3 known e2e fails (ui.choose missing on e2e fake; T9's job).

## 2026-06-17 — T8 critic verdict: PASS

T8 (note replaces FEEDBACK_QUESTION at Gate 1/Gate 2 request-changes when a note
is present; follow-up still runs when absent) verified by critic. Both gates:
`feedback = note !== undefined && note !== '' ? note : await ui.ask(FEEDBACK_QUESTION)`.
Empty-note guard prevents an empty/whitespace note suppressing the follow-up;
free text from "Something else..." (carried as note by T6/T7) counts as a note.
Journal write, approve/abort branches, constants, gateLabel, writeStatus all
untouched. Tests at both gates assert WITH-note => follow-up NOT asked + note
drives re-dispatch context + note journaled, and WITHOUT-note => follow-up asked
— non-tautological (the throwing scriptedUI fake fails loudly if ask is wrongly
called). T6/T7 with-note tests correctly updated to the new behaviour.
tests/specify.test.ts + tests/plan.test.ts 28 passed; tsc clean; full suite 240
passed, 1 skip, only the 3 known e2e fails (T9).

## 2026-06-17 — T9 critic verdict: PASS — spec 003 DONE

T9 (regression sweep) verified by critic. AC10 headline: `git diff HEAD --
src/config.ts src/phases/orient.ts` is EMPTY — non-gate select/confirm call
sites unchanged (config model picker + confirm; orient confirm + select intact).
e2e fake repaired: gained `choose` (scripted ChoiceResult) + confirmWithNote
throw-stub (provably never called — e2e repos are clean+committed so
gitSafetyCheck returns true without prompting); the 3 e2e gate tests retargeted
select->choose with assertions PRESERVED (same advance/reject outcomes). New
implement.test.ts drift-freeText test (the deferred T5 follow-up): freeText then
valid option => 2 choose calls (re-prompt), final decision `amend`, free text
journaled as Note — non-tautological.

Full suite: 244 passed, 1 pre-existing env-gated skip (smoke.test.ts), 0 failed.
tsc --noEmit clean. Critic holistic AC1–AC10 spot-check: all satisfied; no
option-set constant (GATE1_*/GATE2_*/DRIFT_*) or gate decision changed.

All 9 tasks complete. Spec 003 status set to DONE.
