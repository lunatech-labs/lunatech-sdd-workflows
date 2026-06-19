# Implementation Plan: Focus — a CLI Pomodoro timer

> For spec: specs/001-focus-timer/spec.md
> Status: DRAFT (approve at Gate 2)
> Target runtime: Node.js v22 (verified locally), stdlib only.

## Technical approach

- **Single-file executable `focus.js`** at the repo root, with a
  `#!/usr/bin/env node` shebang. Pure Node standard library, no `package.json`
  dependencies, no network. The file exports its pure functions (parsing,
  validation, formatting) and only runs the CLI when invoked directly
  (`if (import.meta.url === ...)` / `require.main === module` guard), so tests
  can import the logic without launching a real timer.
- **Separate pure logic from side effects.** Argument parsing, validation, and
  countdown formatting are pure functions returning plain data. Rendering
  (writing to a stream), the bell, the banner, and the wall-clock ticking are
  thin side-effecting wrappers. This is what makes AC1/AC2 verifiable in
  milliseconds rather than minutes.
- **Injectable time and I/O.** The timer-runner function takes its
  dependencies as parameters with real defaults: a `now` clock, a `sleep`/tick
  scheduler (or `setInterval`), the output stream (`process.stdout`), and an
  optional `tickMs`/speed factor. Tests pass a fake clock and a tiny tick
  interval so a "25-minute" interval completes instantly. Production passes the
  real `setInterval` and `Date.now`.
- **Countdown rendering** uses carriage-return overwrite: write
  `\r${label} ${MM:SS}` to stdout on each tick (no newline), so a single line
  updates in place at least once per second (AC1). On interval end, write a
  trailing newline, emit the bell + banner, then start the next interval.
- **Argument parsing** uses `node:util`'s `parseArgs` (stdlib, stable in
  Node 22) for `--work`, `--break`, `--help`, plus the positional `start`
  command. Values are validated to be positive integers (minutes); invalid
  values produce a stderr message and a non-zero exit (AC5) before any timer
  starts.
- **Testing** uses the built-in `node:test` runner with `node:assert`
  (stdlib). Tests live in `test/focus.test.js` and import the pure functions
  from `focus.js`. The timer loop is tested by injecting a fake scheduler that
  fires ticks synchronously and capturing writes to a fake stream — verifying
  countdown updates, the work-to-break transition, the bell, and the banner
  without real waiting. Run with `node --test`.

## File layout

```
focus.js              # single-file CLI + exported pure functions
test/focus.test.js    # node:test suite, stdlib only
```

No `package.json` is required to run or test (`node focus.js`, `node --test`).
If one is added for ergonomics it must declare zero dependencies; it is
optional and not part of the contract.

## Key design decisions

### Duration injection (critical for fast tests)

The interval runner has a signature roughly like:

```
async function runInterval({ label, totalSeconds, deps })
// deps = { write, bell, scheduleTick, now }
```

- In production, `scheduleTick` wraps `setInterval(fn, 1000)` and resolves when
  the countdown hits zero.
- In tests, `scheduleTick` is a fake that invokes the tick callback
  synchronously `totalSeconds` times (or until done), so a 1500-second work
  interval finishes in microseconds. No real clock elapses.

This keeps AC1 (updates at least once per second) and AC2 (transition + bell +
banner) provable in unit tests in well under a second, satisfying the "must be
verifiable quickly" requirement.

### Countdown format

`formatTime(totalSeconds) -> "MM:SS"` is a pure function (e.g.
`1500 -> "25:00"`, `65 -> "01:05"`). Tested directly. Rendering writes
`\r${label}: ${formatTime(remaining)} ` so each second overwrites the same
terminal line.

### Notification

`notify(write, bell, label)`: writes a newline, the bell byte `\x07` (`\a`),
then a banner line (e.g. `=== Work complete! Time for a break. ===`). The bell
and write are injectable so tests assert the bell was emitted exactly once per
interval end (AC2) without making noise.

### Argument parsing & validation

- `parseArguments(argv) -> { command, work, break, help, error }`.
- `--help` or no command (or `-h`) sets `help: true`.
- `--work` / `--break` must parse to integers `> 0`; otherwise return a
  descriptive `error` string. Non-integer (`abc`), zero, and negative (`-5`)
  all fail (AC5).
- Defaults: `work = 25`, `break = 5` (minutes).
- The main entry inspects the parsed result: on `error`, write to stderr and
  `process.exit(1)`; on `help`, print usage and `process.exit(0)`; otherwise
  run `start`.

### Help text (AC4)

Usage block lists the `start` command and the `--work` / `--break` flags, with
defaults shown. Printed to stdout, exit 0.

## Per-task detail

### T1 — Scaffold `focus.js` with exported pure-function skeleton + help text

- **Files:** create `focus.js`.
- **Approach:** shebang, module guard, and stub exports: `parseArguments`,
  `formatTime`, `runInterval`, `notify`, `helpText`, `main`. Implement
  `helpText()` fully (usage listing `start`, `--work`, `--break`). Wire `main`
  so `--help`/`-h`/no-args prints help and exits 0.
- **Verify (critic):** `node focus.js --help` prints usage mentioning `start`,
  `--work`, `--break` and exits 0 (`echo $?` -> 0). Verifies AC4.

### T2 — Failing tests for argument parsing & validation

- **Files:** create `test/focus.test.js`.
- **Approach:** import `parseArguments`; add tests for defaults (25/5), flag
  overrides (`--work 50 --break 10`), and invalid inputs (`--work abc`,
  `--work -5`, `--work 0`) returning an `error`. Tests are expected to fail
  until T3.
- **Verify (critic):** `node --test` runs and shows these tests failing (red).
  Test-first guard for AC3/AC5.

### T3 — Implement `parseArguments` + validation to pass T2

- **Files:** modify `focus.js`.
- **Approach:** use `node:util` `parseArgs` for `--work`/`--break`/`--help`;
  coerce and validate positive integers; return `{command, work, break, help,
  error}`. Wire `main` to exit non-zero on `error` (stderr) and run start
  otherwise.
- **Verify (critic):** `node --test` (T2 now green); `node focus.js start
  --work abc` prints to stderr and `echo $?` is non-zero without starting a
  timer. Verifies AC3, AC5.

### T4 — Implement `formatTime` + tests

- **Files:** modify `focus.js`, modify `test/focus.test.js`.
- **Approach:** pure `formatTime(seconds) -> "MM:SS"` zero-padded; add unit
  tests (`1500 -> "25:00"`, `65 -> "01:05"`, `0 -> "00:00"`).
- **Verify (critic):** `node --test` shows formatTime tests green. Supports
  AC1/AC2 rendering.

### T5 — Implement `runInterval` with injectable scheduler + countdown tests

- **Files:** modify `focus.js`, modify `test/focus.test.js`.
- **Approach:** `runInterval` ticks once per second via injected
  `scheduleTick`, writing `\r{label}: {MM:SS}` each tick down to 00:00. Tests
  inject a synchronous fake scheduler and fake write stream; assert the
  countdown wrote at least one update per second and reached `00:00` for a
  small interval (e.g. 3 seconds) without real waiting.
- **Verify (critic):** `node --test` shows countdown tests green. Verifies AC1.

### T6 — Implement `notify` (bell + banner) + end-of-interval transition tests

- **Files:** modify `focus.js`, modify `test/focus.test.js`.
- **Approach:** `notify` emits bell `\x07` + banner via injected sinks. A
  `runSession` orchestrator runs work then break, calling `notify` between.
  Tests inject fakes and assert: bell fired at work end, banner printed, then a
  break countdown began with the configured break duration.
- **Verify (critic):** `node --test` green; assert bell count and break-start.
  Verifies AC2 (and AC3 via configured break duration).

### T7 — Wire `main` end-to-end with real dependencies + smoke test

- **Files:** modify `focus.js`.
- **Approach:** `main` builds production deps (real `setInterval`-based
  scheduler, `process.stdout`, real bell) and runs `runSession`. Make file
  executable (`chmod +x`).
- **Verify (critic):** a short manual/automated smoke run with tiny injected
  durations (or a 1-second work/break via internal seconds override used only
  in the smoke harness) shows countdown, bell, banner, break countdown. Full
  `node --test` passes. Verifies AC1, AC2 end-to-end.

## Risks & pitfalls

- **`parseArgs` and negative numbers:** `node:util` `parseArgs` can interpret a
  leading-dash value (`--work -5`) as another option rather than a value.
  Validation must handle both "missing value" and "looks like a flag" and still
  produce the AC5 error path. Mitigation: validate the raw token and treat a
  non-positive-integer (including dash-prefixed) as an error; consider reading
  the raw argv slice if `parseArgs` rejects it.
- **Carriage-return rendering in non-TTY:** when stdout is not a TTY (piped,
  captured in tests), `\r` overwrite is invisible/irrelevant. Keep rendering
  logic injectable and assert on the sequence of writes rather than terminal
  appearance.
- **Don't let real timers leak into tests.** All waiting must go through the
  injected scheduler; never call the real `setInterval`/`setTimeout` from
  testable functions. A stray real timer would make the suite slow and flaky.
- **Exit codes:** ensure the error path exits non-zero *before* any timer
  starts (AC5 explicitly requires "without starting a timer").
- **Bell byte:** `\a` is `\x07`; emit the byte, not the literal backslash-a.
