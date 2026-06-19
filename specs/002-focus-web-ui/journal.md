# Journal: 002-focus-web-ui

Append-only log of decisions, drift, and critic verdicts.

## Gate 1 (SPECIFIED)

- Spec approved. Architecture pinned: Node stdlib server reusing focus.js,
  polled JSON state, Lunatech styling (navy #0a1e50, pink #db2777, Poppins).
- User addition during Gate 1: Dockerfile + compose.yaml for one-command
  `docker compose up`, local demo only, no auth. Added AC8.

## Scope amendment (post first plan, pre Gate 2)

- User asked to set work and rest times in the compose file for easy demos.
  Decision: work + break both in scope, configurable via env vars
  (WORK_SECONDS / BREAK_SECONDS) set in compose.yaml; defaults 1500 / 300;
  invalid values fall back to defaults with a logged warning. Added `phase`
  to state JSON. Work to break transition reuses focus.js notify banner text.
  Start while `done` restarts from the work phase. No UI duration inputs, no
  sound. Spec sections 3, 4, 5 amended; planner re-run.

## Gate 2 (PLANNED)

- Revised plan + 6-task breakdown approved. Decision on planner open question:
  state JSON carries a documented optional `banner` field (null until the
  work-to-break transition); AC2's four fields are asserted explicitly so the
  extra field does not break AC2.

## Implementation verdicts

- T1 (failing session unit tests): critic PASS. test/session.test.js only, no
  production code. Fails cleanly (MODULE_NOT_FOUND on lib/session.js), all ACs
  asserted, banner sourced from focus.js notify, injectable scheduler. The test
  defines the concrete lib/session.js contract: createSession({ durations,
  scheduler }), scheduler shape { scheduleTick, tick, pending }, parseDurations
  returning { workSeconds, breakSeconds }. T2 is bound to this contract.
- T2 (implement lib/session.js): critic PASS. Only lib/session.js added; tests
  14 pass, full suite 33 pass, no regressions. AC6 reuse confirmed genuine:
  counting flows through focus.js runInterval for both phases (remaining parsed
  from runInterval's rendered frame, no parallel counter), banner sourced from
  focus.js notify('Work'), no reimplemented formatter. parseDurations validates
  and falls back correctly. Transition runs synchronously inside the write sink
  (runInterval's Promise resolves async; tests fire ticks synchronously) -
  permitted by plan's adapter allowance.
- T3 (failing HTTP integration tests): critic PASS. Only test/server.test.js
  added; fails cleanly (MODULE_NOT_FOUND on server.js), full suite 34/33/1.
  All ACs (1,2,3,4,5,5a,5b,5c) have real assertions; ephemeral port listen(0),
  injected manual scheduler, clean teardown. Documents server factory contract
  for T4: createServer({ env, scheduler }) -> { server, listen, close }; routes
  GET / /styles.css /app.js /api/state, POST /api/start|pause|reset; must not
  arm a real timer when a scheduler is injected.
