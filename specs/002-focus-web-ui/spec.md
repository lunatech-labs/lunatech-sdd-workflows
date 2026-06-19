# Feature Spec: Focus Web UI - a simple, pretty browser timer

> Status: PLANNED
> Spec folder: specs/002-focus-web-ui/

## 1. Mission / Why

The `focus` Pomodoro timer currently runs only in the terminal (spec
001-focus-timer, DONE). Some users would rather glance at a clean browser tab
than watch a terminal countdown. This feature adds a small, attractive web UI
for a single work interval, served by a tiny Node server that reuses the
existing `focus.js` timer logic so the browser and CLI share one source of
truth. The look follows the Lunatech brand (deep navy, pink accent, Poppins).

## 2. Outcome

A user starts the server (e.g. `node server.js`), opens `http://localhost:PORT`
in a browser, and sees a centered card on a deep-navy background showing a large
`MM:SS` countdown for a 25-minute work interval. Start, Pause, and Reset buttons
control the timer. The countdown is driven by the Node server (which reuses
`focus.js`), and the browser reflects the server's session state.

## 3. Scope

### In scope

- A small Node HTTP server (`server.js`) using the standard library only, that:
  - serves the static UI assets from `public/`, and
  - exposes a tiny JSON API for session state and control:
    `GET /api/state`, `POST /api/start`, `POST /api/pause`, `POST /api/reset`.
- Server-side session state driven by reused `focus.js` logic: a work interval
  followed by a break interval, exposing remaining seconds, the current phase
  (work/break), and status (idle/running/paused/done). When the work interval
  reaches zero, a banner announces the transition and the break interval begins.
- Configurable work and break durations via environment variables (set in
  `compose.yaml`) so a demo can use short durations (e.g. 10s work / 5s break)
  without waiting 25 minutes. Defaults are 25-minute work / 5-minute break when
  unset. Durations are NOT editable from the browser UI.
- A single-page UI in `public/` (`index.html` + CSS + a small JS file) that:
  - renders a large `MM:SS` countdown, updating at least once per second while running,
  - provides Start, Pause, and Reset controls wired to the API, and
  - is styled in the Lunatech aesthetic (navy background `#0a1e50`, pink accent
    `#db2777`, white text, Poppins with a sans-serif fallback), and shows the
    current phase (Work / Break) plus the transition banner.
- Reuse (not reimplementation) of `focus.js`'s countdown semantics: the server
  drives the work interval through `focus.js` exports (e.g. `runInterval` /
  `formatTime`) via injected dependencies; `focus.js` itself is not rewritten.
- A `Dockerfile` plus a Docker Compose file (`compose.yaml`) so the whole app
  runs in a container with a single command (`docker compose up`), serving the
  UI on a published local port. Demo use only, run locally, no authentication.

### Out of scope

- No duration controls in the browser UI: work/break durations are configured
  only via environment variables (Compose file), not editable from the page.
- No "long break" every 4th interval, and no repeating multi-cycle loop: a
  single work then break sequence per session (Start may restart it).
- No sound / terminal bell / browser audio notifications in v1: the work-to-break
  transition is announced by an on-screen banner only (visual, no audio).
- No persistence, history, statistics, accounts, or multi-session support.
- No external runtime dependencies, build step, bundler, or framework (no npm
  install): standard-library Node plus hand-written HTML/CSS/JS only.
- No HTTPS, authentication, or multi-client synchronization guarantees (single
  local user assumed; this is a local demo only).
- No production-grade container hardening, orchestration (Kubernetes, swarm),
  registry publishing, or cloud deployment: the container is for local demo use
  via `docker compose up` only.

## 4. Constraints & Decisions

- Runtime: Node.js (v22 available locally). Standard library only; no external
  dependencies and no build/bundler step. UI assets are plain static files.
- The server reuses `focus.js` via `require('../focus.js')` (or equivalent),
  driving the countdown with the existing injectable-scheduler pattern rather
  than reimplementing the timer in the browser. The work-then-break sequence and
  the transition reuse `focus.js` semantics (e.g. `runInterval`, `formatTime`,
  and the `notify` banner text via `runSession`'s pattern) rather than
  reimplementing them.
- The server holds a single in-memory session (one user, local use). State is
  exposed as JSON: `{ remainingSeconds, totalSeconds, phase, status }` where
  `phase` is one of `work | break` and `status` is one of
  `idle | running | paused | done`. `totalSeconds` reflects the duration of the
  current phase.
- Work and break durations come from environment variables read at startup:
  `WORK_SECONDS` and `BREAK_SECONDS` (whole seconds, for fast demos). When
  unset, defaults are 1500 (25 min) work and 300 (5 min) break. Invalid values
  (non-positive or non-integer) fall back to the defaults with a logged warning;
  they do not crash the server.
- Lifecycle: a session runs the work phase, then on reaching zero announces a
  transition banner and runs the break phase; when the break reaches zero the
  status is `done`. Pressing Start while `done` restarts from the work phase at
  the configured durations. Pause/resume and Reset apply throughout.
- The browser polls `GET /api/state` on an interval (at least once per second)
  to render the countdown; control buttons issue `POST` requests. No WebSocket
  is required.
- Listening port is fixed/known (default `3000`, overridable via `PORT` env
  var) and logged on startup so the user knows the URL to open. The Compose
  file publishes this port to the host so the browser can reach it.
- Containerization uses a stock official Node base image (no extra runtime
  dependencies installed, since the app is stdlib only). `docker compose up`
  builds and starts the app with a single command and no further setup. The
  Compose file sets `WORK_SECONDS` and `BREAK_SECONDS` (with short demo values)
  so durations are easy to change in one place for a demonstration.
- Styling tokens (from lunatech.com): primary accent pink `#db2777`, deep navy
  background `#0a1e50` (with darker `#081a47` accents), white `#ffffff` text,
  muted grey `#c5c5c5`; font Poppins with `sans-serif` fallback. Fonts loaded
  via a web-safe fallback if Poppins is unavailable (no external font fetch
  required for the page to render correctly).
- Documents and code use no em dashes.

## 5. Acceptance Criteria (how you'll verify it)

- [ ] AC1 (serve): Given the server is started, when a client sends
  `GET /`, then the server responds 200 with an HTML document that references
  the UI's CSS and JS assets, and those asset requests also return 200.
- [ ] AC2 (initial state): Given a freshly started server with default
  durations, when a client sends `GET /api/state`, then it returns 200 with JSON
  `{ remainingSeconds: 1500, totalSeconds: 1500, phase: "work", status: "idle" }`
  (25-minute work interval, not yet started).
- [ ] AC3 (start counts down): Given an idle session, when a client sends
  `POST /api/start` and then polls `GET /api/state` after time passes, then
  `status` becomes `"running"`, `phase` is `"work"`, and `remainingSeconds`
  decreases over time (strictly less than the work total on a later poll), at a
  rate of about one per second.
- [ ] AC4 (pause/resume): Given a running session, when a client sends
  `POST /api/pause`, then `status` becomes `"paused"` and `remainingSeconds`
  stops decreasing across subsequent polls; when a client then sends
  `POST /api/start`, then `status` returns to `"running"` and the countdown
  resumes from the paused value.
- [ ] AC5 (reset): Given a running or paused session, when a client sends
  `POST /api/reset`, then `status` returns to `"idle"`, `phase` returns to
  `"work"`, and `remainingSeconds` returns to the work total.
- [ ] AC5a (work to break transition): Given a running session whose work phase
  reaches zero, when polled, then `phase` becomes `"break"`, `remainingSeconds`
  resets to the break total, the session keeps running through the break, and a
  transition banner (the `focus.js` work-complete banner text) is available in
  the state or rendered by the UI. When the break phase reaches zero, `status`
  becomes `"done"`.
- [ ] AC5b (env-configured durations): Given the server is started with
  `WORK_SECONDS=10` and `BREAK_SECONDS=5`, when a client polls `GET /api/state`
  before starting, then `totalSeconds` and `remainingSeconds` are `10`
  (`phase: "work"`); after starting and the work phase elapses, the break total
  is `5`. Given invalid values (e.g. `WORK_SECONDS=abc` or `-1`), the server
  falls back to the defaults and still starts.
- [ ] AC5c (done then restart): Given a session with `status: "done"`, when a
  client sends `POST /api/start`, then the session restarts from the work phase
  at the configured work total with `status: "running"`.
- [ ] AC6 (reuse): Given the codebase, when the server's timer behavior is
  inspected, then it drives the countdown and the work-to-break transition
  through `focus.js` exports (e.g. `formatTime`, `runInterval`, and the `notify`
  banner text) rather than reimplementing the MM:SS formatting, per-second
  counting, or banner text independently.
- [ ] AC7 (styling): Given the rendered page, when the UI is inspected, then it
  uses the Lunatech tokens (navy background `#0a1e50`, pink accent `#db2777`,
  Poppins font with sans-serif fallback) and shows a large `MM:SS` countdown,
  the current phase (Work / Break), the transition banner, and Start, Pause, and
  Reset controls.

- [ ] AC8 (container): Given a `Dockerfile` and `compose.yaml` at the repo root,
  when a user runs `docker compose up` (single command, no prior setup), then
  the image builds, the container starts the server, the configured port is
  published to the host, and `GET /` plus `GET /api/state` succeed against the
  host port. The Compose file sets `WORK_SECONDS` and `BREAK_SECONDS` so the
  demo durations are visible and editable in one place. Verification of the
  build/run may use `docker compose config` / build if a Docker daemon is
  unavailable in the test environment.

## 6. Task Breakdown

> Sequential, test-first. Each task is one implementer spawn. Tasks reference
> the acceptance criteria they verify and declare their dependencies. The
> session model and HTTP transport are kept separate so timer logic stays
> unit-testable with injectable time (no real waits across either phase). All
> ticking and the work-to-break transition are driven through `focus.js`
> exports (`formatTime`, `runInterval`, and the `notify` banner text);
> `focus.js` is not modified.

### [x] T1: Failing unit tests for the session model (incl. phase, transition, env config)

- **Does:** create `test/session.test.js` with `node:test` + `node:assert`,
  written against the `lib/session.js` contract in plan.md. Cover, with an
  injectable scheduler (no real timers): initial snapshot
  `{ remainingSeconds: 1500, totalSeconds: 1500, phase: 'work', status: 'idle' }`;
  start -> running; firing N injected ticks decrements `remainingSeconds` by N;
  pause freezes remaining; start from paused resumes; reset returns to
  `{ 1500, 1500, 'work', 'idle' }`; work reaching 0 transitions to
  `phase: 'break'` with `totalSeconds`/`remainingSeconds` = break total, still
  `running`, and a `banner` equal to the `focus.js` `notify('Work')` banner
  text (AC5a, AC6); break reaching 0 -> `status: 'done'`; start from `done`
  restarts to work / running at the configured work total (AC5c); and a pure
  `parseDurations(env)` helper that maps `{ WORK_SECONDS: '10', BREAK_SECONDS:
  '5' }` -> `{ 10, 5 }` and invalid `{ WORK_SECONDS: 'abc' }` / `'-1'` / `'0'`
  -> defaults `{ 1500, 300 }` (AC5b). Also assert that advancing the injected
  tick (and only that) is what advances `remainingSeconds` in BOTH phases (AC6).
  Tests are expected to FAIL until T2 (no `lib/session.js` yet).
- **Verify (critic):** `node --test` runs and shows these session tests failing
  (red). No real timers used (suite completes in well under a second).
- verifies: AC2, AC3, AC4, AC5, AC5a, AC5b, AC5c, AC6
- depends_on: none

### [x] T2: Implement `lib/session.js` reusing focus.js (make T1 pass)

- **Does:** create `lib/session.js`. Import `formatTime`, `runInterval`, and
  `notify` from `../focus.js`. Provide a pure `parseDurations(env)` that
  validates `WORK_SECONDS` / `BREAK_SECONDS` (regex `^\d+$` and `> 0`), falling
  back to 1500 / 300 with a `console.warn` on invalid input. Construct the
  session with injectable durations (or env) and an injectable scheduler hook.
  Model idle/running/paused/done and the work/break phases with a
  server-controllable scheduler so the per-second decrement in EACH phase is
  driven by `runInterval`'s tick (not an independent counter), per plan.md
  "focus.js reuse". At the work-to-break boundary, capture the banner text by
  calling `notify` with a capturing write sink and a no-op bell (do not hardcode
  it), switch phase to break, and keep running; at break 0 set `done`. Start
  from `done` restarts at the configured work total. Expose `getState()`,
  `start()`, `pause()`, `reset()`. `totalSeconds` always reflects the current
  phase.
- **Verify (critic):** `node --test` shows the T1 session tests green; the
  decrement-per-tick tests confirm counting flows through `runInterval` for both
  phases, and the banner test confirms the text is sourced from `focus.js`'s
  `notify`. No em dashes.
- verifies: AC2, AC3, AC4, AC5, AC5a, AC5b, AC5c, AC6
- depends_on: T1

### [x] T3: Failing HTTP integration tests for the server (incl. transition, env, restart)

- **Does:** create `test/server.test.js`. Start the server via a factory that
  accepts an injectable scheduler AND injectable durations/env, on an ephemeral
  port (`listen(0)`), so ticks are driven without real waits; use the stdlib
  `http` client or `fetch`. Assert: GET `/` -> 200 HTML referencing `styles.css`
  and `app.js`, and those assets -> 200 (AC1); GET `/api/state` -> 200 with
  `remainingSeconds: 1500, totalSeconds: 1500, phase: 'work', status: 'idle'`
  (assert these four fields explicitly so an optional `banner` does not break
  the check) (AC2); POST `/api/start` + driven ticks -> `running`, `phase:
  'work'`, decreased `remainingSeconds` (AC3); POST `/api/pause` freezes, then
  POST `/api/start` resumes (AC4); POST `/api/reset` ->
  `{ 1500, 1500, 'work', 'idle' }` (AC5); drive work to 0 -> `phase: 'break'`,
  `remainingSeconds === breakTotal`, still running, banner present, then drive
  break to 0 -> `status: 'done'` (AC5a); a server built with
  `{ WORK_SECONDS: '10', BREAK_SECONDS: '5' }` reports totals 10 then 5 across
  the transition, and an invalid env still starts and reports defaults (AC5b);
  from `done`, POST `/api/start` restarts to work/running at the configured
  total (AC5c). Teardown closes the server. Tests are expected to FAIL until T4
  (no `server.js` yet).
- **Verify (critic):** `node --test` runs and shows the server tests failing
  (red), with no leaked open handles hanging the runner.
- verifies: AC1, AC2, AC3, AC4, AC5, AC5a, AC5b, AC5c
- depends_on: T2

### [x] T4: Implement `server.js` (make T3 pass)

- **Does:** create `server.js` using `node:http`/`node:fs`/`node:path` only.
  Expose a factory (e.g. `createServer({ env, scheduler })`) holding one
  `lib/session.js` instance built from `parseDurations(env)`. Route the four
  `/api/*` JSON endpoints (state shape `{ remainingSeconds, totalSeconds, phase,
  status, banner? }`) and static serving from `public/` (correct MIME per
  extension, no path traversal outside `public/`). Default port 3000,
  overridable via `PORT`, logged on startup with the actual bound port.
  Production arms a real ~1000ms interval to fire the session tick only while
  running; the scheduler is injectable for tests. `start` from `done` restarts.
- **Verify (critic):** `node --test` shows the T3 server tests green; manual
  `node server.js` then `curl localhost:3000/` and `curl localhost:3000/api/state`
  return the expected responses; `WORK_SECONDS=10 BREAK_SECONDS=5 node server.js`
  reflects the configured totals; startup logs the URL/port. No em dashes.
- verifies: AC1, AC2, AC3, AC4, AC5, AC5a, AC5b, AC5c
- depends_on: T3

### T5: Build the static UI in `public/` (Lunatech styling, phase + banner)

- **Does:** create `public/index.html`, `public/styles.css`, `public/app.js`.
  Centered card on navy `#0a1e50` (darker `#081a47` accents), pink `#db2777`
  accent, white `#ffffff` text, muted grey `#c5c5c5`; font stack
  `'Poppins', system-ui, ... sans-serif` needing no external fetch. Large MM:SS
  display, a current-phase label (Work / Break), a transition-banner element,
  and Start, Pause, Reset buttons with subtle hover states. `app.js` polls
  `GET /api/state` at least once per second, renders MM:SS (derived from server
  state), shows the phase and the banner (from state), and wires buttons to POST
  then re-fetch.
- **Verify (critic):** content checks: `styles.css` contains `#0a1e50` and
  `#db2777`, references `Poppins` with a `sans-serif` fallback, no external font
  `<link>` required to render; `index.html` has a MM:SS element, a phase element,
  a banner element, and the three controls; `app.js` polls `/api/state`, renders
  phase + banner, and POSTs the control routes. With the server running,
  `GET /styles.css` and `GET /app.js` return 200 with correct MIME (covered by
  AC1 in T3/T4). No em dashes anywhere.
- verifies: AC1, AC7
- depends_on: T4

### T6: Containerization: Dockerfile + compose.yaml (with WORK_SECONDS/BREAK_SECONDS)

- **Does:** create `Dockerfile` (stock official Node base image, e.g.
  `node:22-alpine` or `node:22-slim`; copy source; no installed runtime deps;
  entrypoint `node server.js`), `compose.yaml` (build from local `Dockerfile`,
  publish the configured `PORT` to the host, set `WORK_SECONDS` and
  `BREAK_SECONDS` to short demo values so durations are editable in one place,
  single-command `docker compose up`), and `.dockerignore` (exclude `.git`,
  `specs`, `test`, `smoke`). Pass `PORT` consistently so host-side `GET /` and
  `GET /api/state` match AC1/AC2.
- **Verify (critic):** `docker compose config` parses and shows the local build,
  published port, and the `WORK_SECONDS`/`BREAK_SECONDS` environment (run a real
  `docker compose up` build/run when a Docker daemon is available); otherwise
  file-content checks confirm a stock Node base image, no extra runtime deps,
  `node server.js` entrypoint, host port publishing, and the two duration env
  vars set in `compose.yaml`. No em dashes.
- verifies: AC8
- depends_on: T4

## 7. Open Questions

- AC2 exact state shape vs. optional `banner` field. AC2 lists four fields
  (`remainingSeconds, totalSeconds, phase, status`). The plan adds an optional
  `banner` field (null until the work-to-break transition) so the UI can render
  the transition banner text sourced from `focus.js`. The server tests assert
  the four spec'd fields explicitly rather than deep-equality on the whole
  object, so an extra `banner: null` does not break AC2. If the user wants
  `banner` to be a guaranteed, documented field in the state contract (or wants
  it strictly excluded until the transition), confirm at Gate 2.
