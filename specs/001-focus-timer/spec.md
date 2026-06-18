# Feature Spec: Focus — a CLI Pomodoro timer

> Status: SPECIFIED
> Spec folder: specs/001-focus-timer/

## 1. Mission / Why

People doing focused work lose track of time and skip breaks. `focus` is a
tiny terminal command that runs Pomodoro-style work/break intervals so a
developer can time a session without leaving the keyboard or opening an app.
Worth building now as a self-contained example feature.

## 2. Outcome

A user runs `focus start`, sees a live countdown for a 25-minute work
interval, gets a notification when it ends, and is then prompted into a
5-minute break. Running `focus --help` lists the available commands.

## 3. Scope

### In scope

- A `focus start` command that runs a 25-minute work interval followed by a
  5-minute break, with a live countdown in the terminal.
- Flags to override the defaults, e.g. `--work 50 --break 10`.
- A notification (terminal bell + a printed banner) when an interval ends.
- A `focus --help` command that lists available commands and flags.

### Out of scope

- No persistent statistics or history of completed sessions.
- No persisted per-user config in v1; defaults are overridden only via flags.
- No "long break" every 4th interval in v1 (deferred to a follow-up).
- No external services, network calls, or third-party notification systems.

## 4. Constraints & Decisions

- Language / runtime: Node.js. Single-file executable (a `.js`/`.mjs` with a
  shebang), runnable with `node focus.js` or directly once made executable.
- No external runtime dependencies; standard library only. No network calls.
- Custom default durations are supplied only via flags (`--work`, `--break`);
  no config file or environment variables in v1.
- Notification is local only: terminal bell (`\a`) plus a printed banner.

## 5. Acceptance Criteria (how you'll verify it)

- [ ] AC1: Given no flags, when the user runs `focus start`, then a 25-minute
  work interval begins and a countdown updates in the terminal at least once
  per second.
- [ ] AC2: Given a completed work interval, when the work timer reaches zero,
  then the terminal bell fires, a banner is printed, and a 5-minute break
  interval begins with its own countdown.
- [ ] AC3: Given `focus start --work 50 --break 10`, when run, then the work
  interval is 50 minutes and the break interval is 10 minutes (defaults
  overridden).
- [ ] AC4 (help): Given `focus --help`, when run, then it prints usage listing
  the `start` command and the `--work` / `--break` flags, and exits 0.
- [ ] AC5 (errors): Given an invalid flag value (e.g. `--work abc` or
  `--work -5`), when run, then the program prints an error to stderr and exits
  with a non-zero status, without starting a timer.

## 6. Task Breakdown

<!-- Filled in by the planner, approved at Gate 2. -->

## 7. Open Questions

- None outstanding. (Runtime pinned to Node.js; config deferred; long break
  deferred to a follow-up spec.)
