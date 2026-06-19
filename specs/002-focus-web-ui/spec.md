# Feature Spec: Focus Web UI — a simple, pretty browser timer

> Status: SPECIFIED
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
- Server-side session state driven by reused `focus.js` logic (a single 25-minute
  work interval), exposing remaining seconds and status (idle/running/paused/done).
- A single-page UI in `public/` (`index.html` + CSS + a small JS file) that:
  - renders a large `MM:SS` countdown, updating at least once per second while running,
  - provides Start, Pause, and Reset controls wired to the API, and
  - is styled in the Lunatech aesthetic (navy background `#0a1e50`, pink accent
    `#db2777`, white text, Poppins with a sans-serif fallback).
- Reuse (not reimplementation) of `focus.js`'s countdown semantics: the server
  drives the work interval through `focus.js` exports (e.g. `runInterval` /
  `formatTime`) via injected dependencies; `focus.js` itself is not rewritten.
- A `Dockerfile` plus a Docker Compose file (`compose.yaml`) so the whole app
  runs in a container with a single command (`docker compose up`), serving the
  UI on a published local port. Demo use only, run locally, no authentication.

### Out of scope

- No break interval and no work→break transition in v1 (work interval only).
- No configurable work/break durations in the UI (fixed 25-minute work interval);
  duration controls are deferred to a follow-up.
- No sound / terminal bell / browser notifications in v1 (visual countdown only).
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
  than reimplementing the timer in the browser.
- The server holds a single in-memory session (one user, local use). State is
  exposed as JSON: `{ remainingSeconds, totalSeconds, status }` where `status`
  is one of `idle | running | paused | done`.
- The browser polls `GET /api/state` on an interval (at least once per second)
  to render the countdown; control buttons issue `POST` requests. No WebSocket
  is required.
- Listening port is fixed/known (default `3000`, overridable via `PORT` env
  var) and logged on startup so the user knows the URL to open. The Compose
  file publishes this port to the host so the browser can reach it.
- Containerization uses a stock official Node base image (no extra runtime
  dependencies installed, since the app is stdlib only). `docker compose up`
  builds and starts the app with a single command and no further setup.
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
- [ ] AC2 (initial state): Given a freshly started server, when a client sends
  `GET /api/state`, then it returns 200 with JSON
  `{ remainingSeconds: 1500, totalSeconds: 1500, status: "idle" }`
  (25-minute work interval, not yet started).
- [ ] AC3 (start counts down): Given an idle session, when a client sends
  `POST /api/start` and then polls `GET /api/state` after time passes, then
  `status` becomes `"running"` and `remainingSeconds` decreases over time
  (strictly less than 1500 on a later poll), at a rate of about one per second.
- [ ] AC4 (pause/resume): Given a running session, when a client sends
  `POST /api/pause`, then `status` becomes `"paused"` and `remainingSeconds`
  stops decreasing across subsequent polls; when a client then sends
  `POST /api/start`, then `status` returns to `"running"` and the countdown
  resumes from the paused value.
- [ ] AC5 (reset): Given a running or paused session, when a client sends
  `POST /api/reset`, then `status` returns to `"idle"` and `remainingSeconds`
  returns to `1500`.
- [ ] AC6 (reuse): Given the codebase, when the server's timer behavior is
  inspected, then it drives the countdown through `focus.js` exports (e.g.
  `formatTime` and/or `runInterval`) rather than reimplementing the MM:SS
  formatting and per-second counting independently.
- [ ] AC7 (styling): Given the rendered page, when the UI is inspected, then it
  uses the Lunatech tokens (navy background `#0a1e50`, pink accent `#db2777`,
  Poppins font with sans-serif fallback) and shows a large `MM:SS` countdown
  with Start, Pause, and Reset controls.

- [ ] AC8 (container): Given a `Dockerfile` and `compose.yaml` at the repo root,
  when a user runs `docker compose up` (single command, no prior setup), then
  the image builds, the container starts the server, the configured port is
  published to the host, and `GET /` plus `GET /api/state` succeed against the
  host port (same responses as AC1 and AC2). Verification of the build/run may
  use `docker compose config` / build if a Docker daemon is unavailable in the
  test environment.

## 6. Task Breakdown

> To be filled by the planner (Phase 2).

## 7. Open Questions

- None outstanding. (Architecture pinned: Node stdlib server reusing focus.js,
  polled JSON state, work-only v1, no sound, fixed 25-minute duration.)
