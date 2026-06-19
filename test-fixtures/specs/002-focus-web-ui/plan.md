# Implementation Plan: Focus Web UI — a simple, pretty browser timer

> For spec: specs/002-focus-web-ui/spec.md
> Status: DRAFT (re-planned after the spec amendment expanding scope to
> work->break transition + env-configured durations; approve at Gate 2)
> Target runtime: Node.js v22 (verified locally: v22.20.0), stdlib only.

## What changed since the first plan

The spec was amended to expand scope. This plan is revised to match:

1. Scope is now WORK then BREAK with a transition. When work reaches zero a
   banner announces the transition (reusing the `focus.js` work-complete banner
   text) and the break interval runs. When break reaches zero, status is
   `done`.
2. Durations are configurable via env vars read at startup: `WORK_SECONDS`,
   `BREAK_SECONDS` (whole seconds, for fast demos). Defaults when unset: 1500
   work, 300 break. Invalid values (non-integer, non-positive) fall back to the
   defaults with a logged warning and do NOT crash the server. Durations are
   NOT editable from the browser UI.
3. State JSON gains a `phase` field:
   `{ remainingSeconds, totalSeconds, phase, status }` where `phase` is
   `work | break` and `status` is `idle | running | paused | done`.
   `totalSeconds` reflects the CURRENT phase's duration.
4. Pressing Start while `done` RESTARTS from the work phase at the configured
   durations.
5. `compose.yaml` sets `WORK_SECONDS` and `BREAK_SECONDS` (short demo values) so
   durations are editable in one place. The UI shows the current phase
   (Work / Break) and the transition banner.

## Technical approach

- **Tiny stdlib HTTP server at `server.js`** (repo root) using `node:http`,
  `node:fs`, `node:path` only. No framework, no router library, no build step,
  no dependency. It serves static files from `public/` and four JSON API
  routes, holds exactly one in-memory session, reads `WORK_SECONDS` /
  `BREAK_SECONDS` / `PORT` from the environment at startup, and logs the bound
  port.
- **Session logic lives in `lib/session.js`**, separated from the HTTP layer so
  it is unit-testable with `node:test` and an injectable scheduler (mirroring
  the 001 injectable-scheduler pattern). The server is a thin transport wrapper
  around a session object. This preserves the "no real waits in tests"
  property even though a full demo session now spans two phases.
- **Honest reuse of `focus.js`** (AC6) for BOTH the countdown and the
  transition: the session drives the per-phase per-second decrement through
  `runInterval` using a server-controlled scheduler, formats MM:SS via
  `formatTime`, and obtains the work->break transition banner TEXT by calling
  `notify` from `focus.js` (with a capturing write sink and a no-op bell) rather
  than hardcoding the banner string. `focus.js` is NOT modified.
- **Duration config** is parsed by a small pure helper `parseDurations(env)`
  (in `lib/session.js` or a tiny `lib/config.js`) that returns
  `{ workSeconds, breakSeconds }`, applying the same positive-integer validation
  shape as `focus.js`'s `coercePositiveMinutes` (regex `^\d+$` + `> 0`),
  falling back to 1500 / 300 with a `console.warn` on invalid input. Keeping
  this pure means the fallback behaviour is unit-testable without spawning a
  server.
- **Plain static single-page UI in `public/`**: `index.html`, `styles.css`,
  `app.js`. The browser polls `GET /api/state` once per second, renders MM:SS,
  shows the current phase (Work / Break) and the transition banner, and wires
  Start/Pause/Reset to POST routes then re-fetch. No WebSocket. Lunatech tokens
  with a Poppins-or-system font stack that needs no external fetch.
- **Container at repo root**: `Dockerfile` on a stock official Node image
  (`node:22-alpine` or `node:22-slim`) that copies the source and runs
  `node server.js`, plus a `compose.yaml` that builds the image, publishes the
  port to the host, and sets `WORK_SECONDS` / `BREAK_SECONDS` to short demo
  values. `docker compose up` is the single command. No installed runtime deps,
  no hardening, no orchestration.
- **Testing** uses the built-in `node:test` runner with `node:assert`. Session
  unit tests inject a manual scheduler so a multi-phase session is exercised in
  microseconds. HTTP integration tests start the server on an ephemeral port
  (`listen(0)`) with an injectable scheduler, drive the API over real `http`
  requests, and assert state transitions (incl. transition, env-config and
  done->restart) without real waits.

## File layout

```
server.js                 # node:http server: static files + JSON API (thin)
lib/session.js            # Session model: idle/running/paused/done + work/break, reuses focus.js
public/index.html         # single-page UI markup, references styles.css + app.js
public/styles.css         # Lunatech-styled card, big MM:SS, phase label, banner, three buttons
public/app.js             # polls GET /api/state once/sec, renders phase + banner, wires buttons
test/session.test.js      # unit tests for lib/session.js (injectable time)
test/server.test.js       # HTTP integration tests against an ephemeral port
Dockerfile                # stock official Node base image, runs node server.js
compose.yaml              # builds image, publishes PORT, sets WORK_SECONDS/BREAK_SECONDS
.dockerignore             # keep image small (exclude .git, specs, test, smoke)
```

No `package.json` is required to run or test (`node server.js`, `node --test`).
If one is added it must declare zero dependencies and is not part of the
contract. `focus.js` is unchanged. Duration parsing may live in `lib/session.js`
or a tiny `lib/config.js`; the implementer may choose, but it must be a pure,
unit-testable function (it is referenced as `parseDurations` below).

## State / phase / pause / resume / transition model

The session is a small object with explicit, queryable fields:

```
{
  remainingSeconds: number,        // seconds left in the CURRENT phase
  totalSeconds: number,            // duration of the CURRENT phase (work or break)
  phase: 'work' | 'break',
  status: 'idle' | 'running' | 'paused' | 'done',
  banner: string | null            // transition banner text once work has completed (see UI/AC5a)
}
```

`banner` is optional in the snapshot but recommended (see "focus.js reuse"): it
lets the UI render the transition banner from state rather than reinventing the
text. AC2 asserts an EXACT initial JSON shape of
`{ remainingSeconds, totalSeconds, phase, status }`; the implementer must ensure
that when no transition has occurred the snapshot either omits `banner` or sets
it to `null` AND that the AC2 equality check is written to allow a null/absent
banner (the server tests below assert the four spec'd fields explicitly rather
than deep-equality on the whole object, to avoid coupling AC2 to the optional
`banner` field). See Open Questions if a stricter AC2 shape is desired.

Durations come from `parseDurations(process.env)` at construction:
`workSeconds` (default 1500), `breakSeconds` (default 300).

Lifecycle:

- **idle** (initial): `phase = 'work'`, `remainingSeconds = totalSeconds =
  workSeconds`. No ticking. `banner = null`.
- **start (from idle or paused)** -> **running**: begin firing ticks once per
  second in the current phase; each tick decrements `remainingSeconds`.
- **pause (from running)** -> **paused**: stop firing ticks; `remainingSeconds`
  is frozen. Resuming continues from this value in the same phase.
- **start (from paused)** -> **running**: resume ticking from the frozen value.
- **work phase reaches 0** -> **transition**: set `banner` to the `focus.js`
  work-complete banner text, switch `phase` to `'break'`, set
  `totalSeconds = remainingSeconds = breakSeconds`, and KEEP running (continue
  firing ticks into the break phase). No `done` yet.
- **break phase reaches 0** -> **done**: ticking stops; `remainingSeconds = 0`;
  `phase` stays `'break'`; `status = 'done'`. `banner` remains set.
- **reset (from any state)** -> **idle**: cancel any pending tick;
  `phase = 'work'`; `remainingSeconds = totalSeconds = workSeconds`;
  `banner = null`.
- **start (from done)** -> **running, work phase, configured workSeconds**: a
  full RESTART (equivalent to reset then start) at the configured durations
  (AC5c).

`GET /api/state` always returns the current snapshot. The "about one per second"
rate (AC3) is produced by the server-controlled scheduler firing the reused
`runInterval` tick on a ~1000ms real timer in production, and by the injected
manual scheduler in tests.

## focus.js reuse (AC6, load-bearing for BOTH countdown and transition)

`focus.js` exports `formatTime`, `runInterval`, `notify`, `runSession` (and
`BANNERS` only indirectly, via `notify`). The relevant signatures:

- `runInterval({ label, totalSeconds, deps })` where `deps = { write,
  scheduleTick }`. It renders the start frame immediately, then `scheduleTick`s
  each subsequent tick; each tick decrements, renders `\r${label}:
  ${formatTime(value)} `, and re-schedules unless at 0; the Promise resolves at
  00:00. It does NOT natively expose pause/query.
- `notify({ write, bell }, label)` writes `\n`, rings `bell()` once, then writes
  `${banner}\n` where for `'Work'` the banner is
  `=== Work complete! Time for a break. ===`.

### Countdown reuse (per phase)

The session drives EACH phase's countdown through `runInterval` with a
scheduler it controls, and tracks `remainingSeconds` off the same per-second
tick `runInterval` fires; MM:SS is produced with `formatTime`. Concretely:

- The session builds a `controllableScheduler`: `scheduleTick(fn)` stores `fn`
  as the "pending tick" and returns a cancel handle instead of arming a real
  timer directly. The session separately runs a real ~1000ms interval (only
  while `status === 'running'`) that invokes the stored pending tick. Pausing
  stops invoking it; resuming starts again; reset cancels and discards.
- The authoritative `remainingSeconds` is sourced from the same tick
  `runInterval` drives (parse the rendered frame minimally on `:` via the value
  the loop already counts, or track the decrement that the reused tick produces)
  rather than maintaining an independent parallel `remaining--` loop.
- When the work `runInterval` Promise resolves (00:00), the session performs the
  transition (banner + switch to break) and starts a SECOND `runInterval` for
  the break phase using the same controllable scheduler. When the break
  `runInterval` resolves, status becomes `done`. This mirrors `runSession`'s
  Work -> notify -> Break sequencing but with the server owning the scheduler so
  pause/resume/reset work across both phases.

### Transition banner reuse (AC5a / AC6)

Do NOT hardcode the banner string. Obtain it from `focus.js` by calling `notify`
with a capturing write sink and a no-op bell, then extracting the banner line:

```
const lines = [];
notify({ write: (s) => lines.push(s), bell: () => {} }, 'Work');
const banner = lines.join('').split('\n').find((l) => l.includes('==='));
```

Store that string in the snapshot's `banner` field at the transition. The critic
verifies AC6 by (a) grepping that `lib/session.js` imports `formatTime`,
`runInterval`, and `notify` from `focus.js`; (b) a unit test asserting that
advancing the injected scheduler tick (and ONLY that) advances
`remainingSeconds` for both phases (counting flows through `runInterval`, not an
independent counter); and (c) a unit test asserting the transition `banner` text
equals what `focus.js`'s `notify('Work')` produces (i.e. the text is sourced
from `focus.js`, not duplicated).

Note: keep the reuse REAL. The session must not contain its own `remaining -= 1`
per-second loop in parallel with `runInterval`, and must not contain a literal
copy of the banner string.

## API contract

All API responses are `Content-Type: application/json`. Control routes return
the new state snapshot so the browser can update immediately.

| Method | Path | Behavior | Response |
|--------|------|----------|----------|
| GET  | `/api/state` | current snapshot | 200 `{ remainingSeconds, totalSeconds, phase, status, banner? }` |
| POST | `/api/start` | idle/paused -> running; done -> restart at work; begin/resume ticking | 200 snapshot (`status:"running"`) |
| POST | `/api/pause` | running -> paused; freeze remaining | 200 snapshot (`status:"paused"`) |
| POST | `/api/reset` | any -> idle; phase work; remaining = workSeconds; banner null | 200 snapshot (`status:"idle"`) |
| GET  | `/` | serve `public/index.html` | 200 HTML |
| GET  | `/styles.css`, `/app.js` | serve static asset from `public/` | 200 with correct MIME |
| any  | unknown | 404 (JSON `{error}` for `/api/*`, plain text otherwise) | 404 |

Static serving must set a correct `Content-Type` per extension (`.html`,
`.css`, `.js`) and must not allow path traversal outside `public/` (resolve and
verify the path stays within the `public/` root). Control routes should accept
the documented method only (405 or 404 for the wrong method is acceptable; pick
one and be consistent).

## Duration config (AC5b)

- `parseDurations(env)` reads `env.WORK_SECONDS` and `env.BREAK_SECONDS`.
- A value is valid only if it matches `^\d+$` and parses to an integer `> 0`
  (same shape as `focus.js`'s positive-minutes validation, reused conceptually).
- Valid -> use it. Invalid (non-integer, non-positive, e.g. `abc`, `-1`, `0`,
  `1.5`) or unset -> use the default (1500 work / 300 break) and emit a
  `console.warn` naming the offending variable. The server still starts.
- The function is pure (takes an env object, returns `{ workSeconds,
  breakSeconds }`, warns via an injected/`console.warn` log) so it is
  unit-testable without process env mutation; tests pass a plain object.

## Testing strategy

- **Unit (`test/session.test.js`)**: construct a session with an injected
  scheduler (manual fire) and assert:
  - initial snapshot `{ remainingSeconds: 1500, totalSeconds: 1500, phase:
    'work', status: 'idle' }` (default durations);
  - start -> running; firing N ticks decrements `remainingSeconds` by N;
  - pause freezes remaining across further fires; resume continues;
  - reset returns to `{ 1500, 1500, 'work', 'idle' }`;
  - work reaching 0 transitions: `phase` -> `'break'`, `totalSeconds` and
    `remainingSeconds` -> breakSeconds, `status` stays `'running'`, and `banner`
    equals the `focus.js` `notify('Work')` banner text (AC5a, AC6);
  - break reaching 0 -> `status: 'done'`;
  - start from `done` restarts to `{ workSeconds, workSeconds, 'work',
    'running' }` (AC5c);
  - the decrement for BOTH phases is produced by the reused `runInterval` tick
    (AC6);
  - `parseDurations`: env `{ WORK_SECONDS: '10', BREAK_SECONDS: '5' }` ->
    `{ 10, 5 }`; `{ WORK_SECONDS: 'abc' }` and `{ WORK_SECONDS: '-1' }` ->
    defaults `{ 1500, 300 }` (AC5b). All in microseconds, no real timers.
- **HTTP integration (`test/server.test.js`)**: start the server on `listen(0)`
  with an injectable scheduler so ticks can be driven without waiting. Use the
  stdlib `http` client (or `fetch`) to:
  - GET `/` -> 200 HTML referencing `styles.css` and `app.js`, and GET those
    assets -> 200 (AC1);
  - GET `/api/state` -> 200 with `remainingSeconds: 1500, totalSeconds: 1500,
    phase: 'work', status: 'idle'` (assert the four fields explicitly so an
    optional `banner: null` does not break the check) (AC2);
  - POST `/api/start` then drive ticks and poll to see `running`, `phase:
    'work'`, decreased `remainingSeconds` (AC3);
  - POST `/api/pause` -> frozen, then POST `/api/start` -> resume (AC4);
  - POST `/api/reset` -> `{ 1500, 1500, 'work', 'idle' }` (AC5);
  - drive the work phase to 0 -> `phase: 'break'`, `remainingSeconds ===
    breakTotal`, still running, banner present; drive break to 0 -> `status:
    'done'` (AC5a);
  - a server constructed with an env-like override `{ WORK_SECONDS: '10',
    BREAK_SECONDS: '5' }` reports totals of 10 then 5 across the transition;
    invalid env still starts and reports defaults (AC5b). The server factory
    must accept an injectable env/durations argument so this is testable without
    spawning subprocesses;
  - from `done`, POST `/api/start` restarts to work / running at configured
    total (AC5c).
  - Close the server in teardown so no handle leaks.
- **Styling check (AC7)**: content assertion (or critic file-content check) that
  `public/styles.css` contains `#0a1e50` and `#db2777`, references `Poppins`
  with a `sans-serif` fallback (no external font `<link>` required to render);
  `index.html` contains a MM:SS display element, a phase (Work / Break) element,
  a transition-banner element, and Start/Pause/Reset controls; `app.js` polls
  `/api/state` and POSTs the control routes and renders phase + banner.
- **Container check (AC8)**: no Docker daemon in this environment (verified:
  `docker` not on PATH). The critic verifies via `docker compose config` if a
  daemon appears, otherwise via file-content checks: `compose.yaml` builds from
  the local `Dockerfile`, publishes the configured port to the host, sets
  `WORK_SECONDS` and `BREAK_SECONDS`, and runs the server; `Dockerfile` uses a
  stock official Node base image, adds no runtime deps, entrypoint `node
  server.js`. A real `docker compose up` build/run is the gold-standard check
  when a daemon exists.

## Risks & pitfalls

- **Real timers leaking into tests.** As with 001, all ticking must flow through
  the injected scheduler in tests; the server's production ~1000ms interval must
  only be armed in the production path. A stray real timer makes the suite
  slow/flaky and can hang `node --test` by keeping the event loop alive. Ensure
  the server is closed and any interval cleared in teardown.
- **Honest reuse vs. convenience (now two-fold).** It is tempting to write a
  `remaining--` loop and hardcode `=== Work complete! ... ===`. That fails AC6's
  intent twice. The decrement must be driven by `runInterval`'s tick for BOTH
  phases, and the banner text must come from `focus.js`'s `notify`. Make both
  verifiable by test, not just by import.
- **Spanning the transition without `runSession`.** `runSession` awaits Work
  then Break with a single injected scheduler and offers no pause/query, so the
  server cannot use it directly. Drive two sequential `runInterval`s with the
  server-owned controllable scheduler instead, performing the banner capture at
  the boundary. Reset mid-session must cancel cleanly and discard any in-flight
  `runInterval` promise/closure for either phase.
- **AC2 exact shape vs. optional `banner`.** The spec's AC2 lists four fields. A
  naive `assert.deepStrictEqual` against a snapshot that also carries `banner`
  would fail. Either omit `banner` when null or assert the four fields
  explicitly (planned approach). Flagged in Open Questions in case the user
  wants `banner` to be a guaranteed field.
- **Injectable env for AC5b without subprocesses.** The server/session factory
  must accept durations (or an env object) as an argument so the test can
  exercise `WORK_SECONDS=10`/invalid without mutating `process.env` or spawning
  `node`. Plan: `createServer({ env })` / `new Session({ durations })`.
- **Path traversal in static serving.** Resolve requested paths against the
  `public/` root and reject anything that escapes it (`..`). Stdlib only.
- **MIME types.** Serve `.js` as `text/javascript` and `.css` as `text/css`,
  else browsers may refuse the assets and AC1/AC7 break in a real browser even
  if status-code tests pass.
- **Font without external fetch.** Use a stack like `'Poppins', system-ui,
  -apple-system, 'Segoe UI', Roboto, sans-serif` so the page renders without a
  CDN fetch. Do not add a hard `<link>` to Google Fonts.
- **Port logging.** Log the actual bound port (especially with `PORT` set or
  `listen(0)` in tests) so the startup line is truthful.
- **Docker base image, port publishing, and env.** Use a stock official tag; do
  not install packages. Compose must publish the in-container `PORT` to the host
  and set `WORK_SECONDS` / `BREAK_SECONDS` so the demo durations live in one
  place (AC8) and `GET /` and `GET /api/state` match AC1/AC2 host-side.
- **No em dashes** anywhere in code, comments, UI text, or these docs.

## Per-task detail

See spec.md section 6 for the authoritative task list with `verifies:` and
`depends_on:` lines. Summary of verification commands:

- Session/server tests: `node --test` (discovers `test/*.test.js`).
- Static/API by hand: `node server.js` then `curl localhost:3000/` and
  `curl localhost:3000/api/state`; `WORK_SECONDS=10 BREAK_SECONDS=5 node
  server.js` to eyeball env config.
- Container: `docker compose config` (and `docker compose up` build/run where a
  daemon exists), else file-content checks.
