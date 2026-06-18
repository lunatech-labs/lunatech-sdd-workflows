# Journal: 001-focus-timer

Append-only log of decisions, drift, and critic verdicts.

## 2026-06-18 — Gate 1 (SPECIFY)

- Ingested draft `partial-spec-focus-timer.md`. Resolved three open items with the user:
  - Runtime pinned to **Node.js** (draft said "Node or Deno, whichever is simpler").
  - Config: **no persisted config in v1**; flags only.
  - **Long break out of v1** (deferred to a follow-up).
- Acceptance criteria AC1–AC5 authored (draft had none). AC5 added for error handling.
- Spec approved. Status -> SPECIFIED.

## 2026-06-18 — Gate 2 (PLAN)

- Planner produced plan.md and section 6 task breakdown (T1–T7).
- All AC1–AC5 covered by at least one task; depends_on lines present.
- Two planner decisions confirmed by user at Gate 2:
  - Tests live in a separate `test/focus.test.js` (no runtime dep; "single-file" applies to the shipped CLI).
  - AC5 `--work -5` is an explicitly tested edge of `parseArgs`, not an assumption.
- Plan approved. Status -> PLANNED.

## 2026-06-18 — IMPLEMENT

- **T1 (Scaffold + help)**: critic **PASS**. `node focus.js --help` / `-h` / no-args
  print usage listing `start`, `--work`, `--break`; exit 0. Module guard verified
  (import does not launch CLI). Timer/parse/notify correctly left as throwing stubs.
  Supervisor fixed two em dashes in focus.js (org doc convention) before commit; not
  AC-relevant.
- **T2 (Failing tests, test-first)**: critic **PASS**. `test/focus.test.js` created with
  6 tests (defaults 25/5, overrides 50/10, invalid abc/-5/0/bad-break). All 6 run and FAIL
  via the parseArguments stub throwing (genuine red, not import error). focus.js unchanged.
  Stdlib only.
- **T3 (parseArguments + validation)**: critic **PASS**. node --test 6/6 green. AC3
  overrides (50/10) and defaults (25/5) correct. AC5: invalid abc/-5/0 all -> stderr +
  exit 1, no timer, no uncaught throw (parseArgs throw caught for `--work -5`). AC4 help
  intact. formatTime/runInterval/notify still stubs. No em dashes.
  - Note: `--work -5` surfaces parseArgs' raw "ambiguous" message rather than the friendly
    one. Satisfies AC5; flagged as optional future polish.
- **T4 (formatTime + tests)**: critic **PASS**. Pure MM:SS formatter, zero-padded, no hour
  rollover (3600 -> 60:00). 7 tests appended; original 6 intact. node --test 13/13 green.
  runInterval/notify still stubs. No em dashes.
- **T5 (runInterval + injectable scheduler)**: critic **PASS**. AC1 verified: countdown
  writes one CR-overwrite frame per second from totalSeconds down to and including 00:00
  (3s -> 4 frames; 1500s -> 1501 writes). Injected scheduler only; no real setInterval in
  testable path; suite ~150ms, 16/16 green. No bell/banner (T6). notify still stub.
  - Decision: implementer changed main's start path to a "pending T7" stderr+exit 1
    (avoids a real-timer leak before T7 wires production deps). Help/error paths intact.
    Accepted as in-scope; full wiring is T7.
- **T6 (notify + runSession transition)**: critic **PASS**. AC2 verified: at work-zero the
  injected bell fires exactly once, banner prints, then a Break countdown runs to 00:00.
  Ordering asserted (Work frames -> bell+banner -> Break frames). AC3 break-duration honored
  (distinct 3s/5s test would catch a swap). Banner ASCII, no em dashes. Injected scheduler
  only; 19/19 green, ~145ms. main still "pending T7"; help/error intact.
