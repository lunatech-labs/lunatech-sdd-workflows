'use strict';

// T3: Failing HTTP integration tests for the server (server.js).
//
// These tests are written test-first against the server.js contract documented
// in plan.md ("Technical approach", "API contract", "Testing strategy") and
// spec section 6 task T3. server.js does NOT exist yet, so the whole suite is
// EXPECTED TO FAIL (red) with a "Cannot find module '../server.js'" error until
// T4 implements it.
//
// SERVER FACTORY CONTRACT assumed here (T4 must implement exactly this so the
// tests go green):
//
//   const { createServer } = require('../server.js');
//
//   createServer({ env, scheduler }) -> { server, listen, close }
//     - env: a plain object (NOT process.env) used for duration config. The
//       factory passes it through parseDurations(env) from lib/session.js, so
//       { WORK_SECONDS: '10', BREAK_SECONDS: '5' } yields a 10s work / 5s break
//       session and an invalid env (e.g. { WORK_SECONDS: 'abc' }) falls back to
//       the 1500 / 300 defaults. When env is omitted, defaults apply.
//     - scheduler: the injectable tick driver threaded straight into the single
//       lib/session.js instance the server holds (createSession({ durations,
//       scheduler })). It mirrors focus.js's scheduleTick contract and exposes:
//         scheduler.scheduleTick(fn) -> { cancel }  (stores fn as the pending
//           tick; passed into the session/runInterval)
//         scheduler.tick()    -> fires the single pending tick, if any
//         scheduler.pending() -> boolean, whether a tick is currently pending
//       Because the test holds this same scheduler object, it advances the
//       countdown deterministically by calling scheduler.tick() (via the
//       fireTicks helper) instead of waiting on a real ~1000ms timer. The
//       factory must NOT arm a real timer when a scheduler is injected.
//
//   Return shape: an object exposing
//     - server:  the node http.Server instance,
//     - listen(port, cb): start listening (the test uses port 0 for an
//       ephemeral port and reads the bound port from server.address().port),
//     - close(cb): stop the server and release the handle (called in teardown
//       so no open handle hangs the test runner).
//
//   ROUTES (all under the single in-memory session):
//     GET  /            -> 200 text/html (references styles.css and app.js)
//     GET  /styles.css  -> 200 text/css
//     GET  /app.js      -> 200 application/javascript or text/javascript
//     GET  /api/state   -> 200 application/json snapshot
//     POST /api/start   -> 200 snapshot (idle/paused -> running; done -> restart)
//     POST /api/pause   -> 200 snapshot (running -> paused; freeze remaining)
//     POST /api/reset   -> 200 snapshot (any -> idle; phase work; remaining =
//                          workSeconds; banner null)
//
//   STATE SHAPE (JSON): { remainingSeconds, totalSeconds, phase, status, banner? }
//     phase  in { 'work', 'break' }, status in { 'idle','running','paused','done' }.
//     banner is optional (null/absent until the work-to-break transition), so
//     AC2 asserts the four spec'd fields explicitly rather than by deep-equality.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createServer } = require('../server.js');

// Source the expected transition banner text from focus.js itself (NOT a
// hardcoded copy), exactly as the session does: call notify with a capturing
// write sink and a no-op bell, then extract the banner line.
const focus = require('../focus.js');

function expectedWorkBanner() {
  const lines = [];
  focus.notify({ write: (s) => lines.push(s), bell: () => {} }, 'Work');
  return lines
    .join('')
    .split('\n')
    .find((l) => l.includes('==='));
}

// Manual tick scheduler: the injectable driver, identical in shape to the one
// lib/session.js expects (see test/session.test.js). runInterval (via the
// session) calls scheduleTick(fn) to register the NEXT tick; we store it as the
// single pending tick. scheduler.tick() fires that pending tick (which may
// register a further tick). scheduler.pending() reports whether a tick waits.
// No real timer is ever armed, so the suite finishes in well under a second.
function makeManualScheduler() {
  let pendingFn = null;
  const scheduleTick = (fn) => {
    pendingFn = fn;
    return {
      cancel: () => {
        pendingFn = null;
      },
    };
  };
  const tick = () => {
    const fn = pendingFn;
    pendingFn = null;
    if (fn) {
      fn();
    }
  };
  const pending = () => pendingFn !== null;
  return { scheduleTick, tick, pending };
}

// Fire up to `n` ticks, stopping early if nothing is pending (e.g. the phase
// completed or the session is paused/done). Returns the number actually fired.
function fireTicks(scheduler, n) {
  let fired = 0;
  for (let i = 0; i < n && scheduler.pending(); i += 1) {
    scheduler.tick();
    fired += 1;
  }
  return fired;
}

// Start a server built from the factory on an ephemeral port (listen(0)) and
// return a small harness: the bound port, an http-request helper, and a close
// function for teardown. Each test must call harness.close() so no open handle
// hangs node --test.
function startServer({ env, scheduler }) {
  return new Promise((resolve, reject) => {
    let app;
    try {
      app = createServer({ env, scheduler });
    } catch (err) {
      reject(err);
      return;
    }

    app.listen(0, () => {
      const port = app.server.address().port;

      // Minimal stdlib http client. Resolves with { status, headers, body }
      // and, when the body parses as JSON, a parsed `json` field.
      const request = (method, path) =>
        new Promise((res, rej) => {
          const req = http.request(
            { host: '127.0.0.1', port, method, path },
            (response) => {
              const chunks = [];
              response.on('data', (c) => chunks.push(c));
              response.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let json;
                try {
                  json = JSON.parse(body);
                } catch {
                  json = undefined;
                }
                res({
                  status: response.statusCode,
                  headers: response.headers,
                  body,
                  json,
                });
              });
            },
          );
          req.on('error', rej);
          req.end();
        });

      const close = () =>
        new Promise((res) => {
          app.close(() => res());
        });

      resolve({ port, request, close });
    });
  });
}

test('AC1: GET / serves HTML referencing styles.css and app.js, and the assets serve', async () => {
  const scheduler = makeManualScheduler();
  const harness = await startServer({ scheduler });
  try {
    const root = await harness.request('GET', '/');
    assert.strictEqual(root.status, 200, 'GET / should be 200');
    assert.ok(
      /text\/html/.test(root.headers['content-type'] || ''),
      'GET / should be served as text/html',
    );
    assert.ok(root.body.includes('styles.css'), 'index should reference styles.css');
    assert.ok(root.body.includes('app.js'), 'index should reference app.js');

    const css = await harness.request('GET', '/styles.css');
    assert.strictEqual(css.status, 200, 'GET /styles.css should be 200');
    assert.ok(
      /text\/css/.test(css.headers['content-type'] || ''),
      'styles.css should be served as text/css',
    );

    const js = await harness.request('GET', '/app.js');
    assert.strictEqual(js.status, 200, 'GET /app.js should be 200');
    assert.ok(
      /(application|text)\/javascript/.test(js.headers['content-type'] || ''),
      'app.js should be served as application/javascript or text/javascript',
    );
  } finally {
    await harness.close();
  }
});

test('AC2: GET /api/state returns the four spec fields for a fresh default server', async () => {
  const scheduler = makeManualScheduler();
  const harness = await startServer({ scheduler });
  try {
    const res = await harness.request('GET', '/api/state');
    assert.strictEqual(res.status, 200, 'GET /api/state should be 200');
    assert.ok(
      /application\/json/.test(res.headers['content-type'] || ''),
      'state should be served as application/json',
    );
    // Assert the four spec fields EXPLICITLY (not deep-equality) so an optional
    // banner field does not break the check.
    assert.strictEqual(res.json.remainingSeconds, 1500);
    assert.strictEqual(res.json.totalSeconds, 1500);
    assert.strictEqual(res.json.phase, 'work');
    assert.strictEqual(res.json.status, 'idle');
  } finally {
    await harness.close();
  }
});

test('AC3: POST /api/start then driven ticks count down within the work phase', async () => {
  const scheduler = makeManualScheduler();
  const harness = await startServer({
    env: { WORK_SECONDS: '10', BREAK_SECONDS: '5' },
    scheduler,
  });
  try {
    const started = await harness.request('POST', '/api/start');
    assert.strictEqual(started.status, 200, 'POST /api/start should be 200');
    assert.strictEqual(started.json.status, 'running');
    assert.strictEqual(started.json.phase, 'work');
    assert.strictEqual(started.json.remainingSeconds, 10, 'starts at the work total');

    // Drive ticks deterministically via the injected scheduler (no real waits).
    const fired = fireTicks(scheduler, 3);
    assert.strictEqual(fired, 3, 'expected exactly 3 ticks to fire in the work phase');

    const polled = await harness.request('GET', '/api/state');
    assert.strictEqual(polled.json.status, 'running');
    assert.strictEqual(polled.json.phase, 'work');
    assert.ok(
      polled.json.remainingSeconds < 10,
      'remainingSeconds should be strictly less than the work total after ticks',
    );
    assert.strictEqual(polled.json.remainingSeconds, 7, 'three ticks remove three seconds');
  } finally {
    await harness.close();
  }
});

test('AC4: POST /api/pause freezes remaining; POST /api/start resumes from the frozen value', async () => {
  const scheduler = makeManualScheduler();
  const harness = await startServer({
    env: { WORK_SECONDS: '10', BREAK_SECONDS: '5' },
    scheduler,
  });
  try {
    await harness.request('POST', '/api/start');
    fireTicks(scheduler, 3);
    let state = (await harness.request('GET', '/api/state')).json;
    assert.strictEqual(state.remainingSeconds, 7, 'precondition: 3 seconds elapsed');

    const paused = await harness.request('POST', '/api/pause');
    assert.strictEqual(paused.json.status, 'paused');

    // While paused no tick is pending, so nothing advances across further polls.
    const firedWhilePaused = fireTicks(scheduler, 5);
    assert.strictEqual(firedWhilePaused, 0, 'no tick should be pending while paused');
    state = (await harness.request('GET', '/api/state')).json;
    assert.strictEqual(state.status, 'paused');
    assert.strictEqual(state.remainingSeconds, 7, 'remaining must stay frozen while paused');

    const resumed = await harness.request('POST', '/api/start');
    assert.strictEqual(resumed.json.status, 'running');
    assert.strictEqual(resumed.json.remainingSeconds, 7, 'resume continues from the frozen value');

    fireTicks(scheduler, 2);
    state = (await harness.request('GET', '/api/state')).json;
    assert.strictEqual(state.remainingSeconds, 5, 'ticking resumes from where it paused');
  } finally {
    await harness.close();
  }
});

test('AC5: POST /api/reset returns to { 1500, 1500, work, idle }', async () => {
  const scheduler = makeManualScheduler();
  const harness = await startServer({ scheduler });
  try {
    await harness.request('POST', '/api/start');
    fireTicks(scheduler, 4);

    const reset = await harness.request('POST', '/api/reset');
    assert.strictEqual(reset.status, 200, 'POST /api/reset should be 200');
    assert.strictEqual(reset.json.remainingSeconds, 1500);
    assert.strictEqual(reset.json.totalSeconds, 1500);
    assert.strictEqual(reset.json.phase, 'work');
    assert.strictEqual(reset.json.status, 'idle');
  } finally {
    await harness.close();
  }
});

test('AC5a: driving work to 0 transitions to break (running, break total, banner), then break to 0 is done', async () => {
  const scheduler = makeManualScheduler();
  const harness = await startServer({
    env: { WORK_SECONDS: '3', BREAK_SECONDS: '7' },
    scheduler,
  });
  try {
    await harness.request('POST', '/api/start');

    // Drive the work phase to zero. runInterval renders the 00:00 frame and the
    // session transitions to break, keeping running, so break ticks become
    // pending. Fire just enough to clear the work phase.
    for (let i = 0; i < 3 && scheduler.pending(); i += 1) {
      scheduler.tick();
    }

    const atBreak = (await harness.request('GET', '/api/state')).json;
    assert.strictEqual(atBreak.phase, 'break', 'work reaching 0 switches phase to break');
    assert.strictEqual(atBreak.totalSeconds, 7, 'totalSeconds reflects the break total');
    assert.strictEqual(atBreak.remainingSeconds, 7, 'remainingSeconds resets to the break total');
    assert.strictEqual(atBreak.status, 'running', 'session keeps running through the break');
    assert.ok(
      typeof atBreak.banner === 'string' && atBreak.banner.length > 0,
      'a non-empty transition banner must be present',
    );
    assert.strictEqual(
      atBreak.banner,
      expectedWorkBanner(),
      'banner text must equal the focus.js work-complete banner',
    );

    // Drive the break phase all the way down; fireTicks stops once nothing is
    // pending, so this cannot spin once the session is done.
    fireTicks(scheduler, 100);

    const done = (await harness.request('GET', '/api/state')).json;
    assert.strictEqual(done.status, 'done', 'break reaching 0 marks the session done');
    assert.strictEqual(done.remainingSeconds, 0, 'remaining is 0 when done');
  } finally {
    await harness.close();
  }
});

test('AC5b: env durations drive the totals (10 work then 5 break); invalid env falls back to defaults', async () => {
  // Configured short durations.
  const scheduler = makeManualScheduler();
  const harness = await startServer({
    env: { WORK_SECONDS: '10', BREAK_SECONDS: '5' },
    scheduler,
  });
  try {
    const initial = (await harness.request('GET', '/api/state')).json;
    assert.strictEqual(initial.totalSeconds, 10, 'work total reflects WORK_SECONDS=10');
    assert.strictEqual(initial.remainingSeconds, 10);
    assert.strictEqual(initial.phase, 'work');

    await harness.request('POST', '/api/start');
    // Drive the work phase (10s) to zero so the break phase begins.
    for (let i = 0; i < 10 && scheduler.pending(); i += 1) {
      scheduler.tick();
    }

    const atBreak = (await harness.request('GET', '/api/state')).json;
    assert.strictEqual(atBreak.phase, 'break', 'transitioned to break after the work phase');
    assert.strictEqual(atBreak.totalSeconds, 5, 'break total reflects BREAK_SECONDS=5');
    assert.strictEqual(atBreak.remainingSeconds, 5);
  } finally {
    await harness.close();
  }

  // Invalid env still starts and reports defaults (1500 / 300).
  const scheduler2 = makeManualScheduler();
  const harness2 = await startServer({
    env: { WORK_SECONDS: 'abc' },
    scheduler: scheduler2,
  });
  try {
    const state = (await harness2.request('GET', '/api/state')).json;
    assert.strictEqual(state.status, 'idle', 'invalid env still starts the server');
    assert.strictEqual(state.totalSeconds, 1500, 'invalid WORK_SECONDS falls back to 1500');
    assert.strictEqual(state.remainingSeconds, 1500);
    assert.strictEqual(state.phase, 'work');
  } finally {
    await harness2.close();
  }
});

test('AC5c: from done, POST /api/start restarts to work / running at the configured work total', async () => {
  const scheduler = makeManualScheduler();
  const harness = await startServer({
    env: { WORK_SECONDS: '4', BREAK_SECONDS: '3' },
    scheduler,
  });
  try {
    await harness.request('POST', '/api/start');
    fireTicks(scheduler, 100); // drive both phases to zero
    const done = (await harness.request('GET', '/api/state')).json;
    assert.strictEqual(done.status, 'done', 'precondition: session is done');

    const restarted = await harness.request('POST', '/api/start');
    assert.strictEqual(restarted.json.phase, 'work', 'restart returns to the work phase');
    assert.strictEqual(restarted.json.status, 'running', 'restart is running');
    assert.strictEqual(restarted.json.remainingSeconds, 4, 'restart begins at the configured work total');
    assert.strictEqual(restarted.json.totalSeconds, 4, 'totalSeconds reflects the work total on restart');
  } finally {
    await harness.close();
  }
});
