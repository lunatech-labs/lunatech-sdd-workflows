'use strict';

// T1: Failing unit tests for the session model (lib/session.js).
//
// These tests are written test-first against the lib/session.js contract
// documented in plan.md (sections "File layout", "State / phase / pause /
// resume / transition model", "focus.js reuse", and "Duration config").
// lib/session.js does NOT exist yet, so the whole suite is EXPECTED TO FAIL
// (red) with a "Cannot find module" error until T2 implements it.
//
// Contract assumed here (see the report for the rationale; T2 must implement
// exactly this so the tests go green):
//
//   const { createSession, parseDurations } = require('../lib/session.js');
//
//   createSession({ durations, scheduler }) -> session
//     - durations: { workSeconds, breakSeconds } (optional; defaults
//       1500 / 300 when omitted).
//     - scheduler: an injectable tick driver mirroring focus.js's
//       scheduleTick contract. It is an object exposing:
//         scheduler.scheduleTick(fn) -> cancel handle   (passed INTO focus.js's
//           runInterval as deps.scheduleTick; stores fn as the pending tick)
//         scheduler.tick()   -> fires the single pending tick, if any
//         scheduler.pending() -> boolean, whether a tick is currently pending
//       In production this hook is wired to a real ~1000ms interval; in tests
//       we fire scheduler.tick() by hand so no real timers are used.
//
//   session.getState() -> { remainingSeconds, totalSeconds, phase, status, banner }
//   session.start()  -> begin/resume ticking (idle/paused -> running;
//                       done -> restart at work).
//   session.pause()  -> running -> paused; freeze remainingSeconds.
//   session.reset()  -> any -> idle; phase 'work'; remaining = workSeconds;
//                       banner null.
//
// The decrement in BOTH phases must flow through focus.js's runInterval tick
// (driven via scheduler.scheduleTick), not an independent counter: a fired
// scheduler.tick() (and ONLY that) is what advances remainingSeconds.

const test = require('node:test');
const assert = require('node:assert');

const { createSession, parseDurations } = require('../lib/session.js');

// Source the expected transition banner text from focus.js itself (NOT a
// hardcoded copy), exactly as plan.md prescribes: call notify with a capturing
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

// Manual tick scheduler: an injectable driver that mirrors focus.js's
// scheduleTick(fn) contract while letting the test fire ticks by hand, so no
// real timer is ever armed and the suite finishes in well under a second.
//
// runInterval calls scheduleTick(fn) to register the NEXT tick; we store it as
// the single pending tick. scheduler.tick() invokes that pending tick (which,
// inside runInterval, may register a further tick). scheduler.pending()
// reports whether a tick is currently waiting.
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

test('initial snapshot is { 1500, 1500, work, idle } with null banner (AC2)', () => {
  const scheduler = makeManualScheduler();
  const session = createSession({ scheduler });

  const state = session.getState();
  assert.strictEqual(state.remainingSeconds, 1500);
  assert.strictEqual(state.totalSeconds, 1500);
  assert.strictEqual(state.phase, 'work');
  assert.strictEqual(state.status, 'idle');
  // banner is null until the work-to-break transition.
  assert.strictEqual(state.banner, null);
});

test('start() moves to status running, phase work (AC3)', () => {
  const scheduler = makeManualScheduler();
  const session = createSession({ scheduler });

  session.start();
  const state = session.getState();
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(state.phase, 'work');
});

test('firing N injected ticks decrements remainingSeconds by exactly N while running (AC3)', () => {
  const scheduler = makeManualScheduler();
  // Small work duration so we stay inside the work phase while firing ticks.
  const session = createSession({ durations: { workSeconds: 10, breakSeconds: 5 }, scheduler });

  session.start();
  assert.strictEqual(session.getState().remainingSeconds, 10);

  const fired = fireTicks(scheduler, 3);
  assert.strictEqual(fired, 3, 'expected exactly 3 ticks to be available and fire');
  assert.strictEqual(session.getState().remainingSeconds, 7, 'three ticks should remove three seconds');
});

test('only firing the injected tick advances remainingSeconds; nothing advances on its own (AC6)', () => {
  const scheduler = makeManualScheduler();
  const session = createSession({ durations: { workSeconds: 10, breakSeconds: 5 }, scheduler });

  session.start();
  const before = session.getState().remainingSeconds;

  // No tick fired: querying state repeatedly must NOT advance the countdown.
  session.getState();
  session.getState();
  assert.strictEqual(session.getState().remainingSeconds, before, 'state must not self-advance without a tick');

  // A single tick advances by exactly one second (counting flows through
  // runInterval, not an independent loop).
  scheduler.tick();
  assert.strictEqual(session.getState().remainingSeconds, before - 1, 'one tick should remove exactly one second');
});

test('pause() freezes remaining across further (non-)ticks; start() resumes from the frozen value (AC4)', () => {
  const scheduler = makeManualScheduler();
  const session = createSession({ durations: { workSeconds: 10, breakSeconds: 5 }, scheduler });

  session.start();
  fireTicks(scheduler, 3);
  assert.strictEqual(session.getState().remainingSeconds, 7);

  session.pause();
  assert.strictEqual(session.getState().status, 'paused');

  // While paused, the scheduler must hold no pending tick (no countdown
  // progresses), and any attempt to fire does not advance remaining.
  const firedWhilePaused = fireTicks(scheduler, 5);
  assert.strictEqual(firedWhilePaused, 0, 'no ticks should be pending while paused');
  assert.strictEqual(session.getState().remainingSeconds, 7, 'remaining must stay frozen while paused');

  // Resume from the frozen value.
  session.start();
  assert.strictEqual(session.getState().status, 'running');
  assert.strictEqual(session.getState().remainingSeconds, 7, 'resume continues from the frozen value');
  fireTicks(scheduler, 2);
  assert.strictEqual(session.getState().remainingSeconds, 5, 'ticking resumes from where it paused');
});

test('reset() returns to { 1500, 1500, work, idle } with null banner (AC5)', () => {
  const scheduler = makeManualScheduler();
  const session = createSession({ scheduler });

  session.start();
  fireTicks(scheduler, 4);
  session.reset();

  const state = session.getState();
  assert.strictEqual(state.remainingSeconds, 1500);
  assert.strictEqual(state.totalSeconds, 1500);
  assert.strictEqual(state.phase, 'work');
  assert.strictEqual(state.status, 'idle');
  assert.strictEqual(state.banner, null);
});

test('work reaching 0 transitions to phase break (break totals, still running, focus.js banner) (AC5a, AC6)', () => {
  const scheduler = makeManualScheduler();
  const session = createSession({ durations: { workSeconds: 3, breakSeconds: 7 }, scheduler });

  session.start();
  // Drive the entire work phase to zero. runInterval renders the final 00:00
  // frame and resolves; the session then transitions to break and keeps
  // running, so fresh break ticks become pending. Fire enough ticks to clear
  // the work phase but stop before the break phase elapses.
  for (let i = 0; i < 3 && scheduler.pending(); i += 1) {
    scheduler.tick();
  }

  const state = session.getState();
  assert.strictEqual(state.phase, 'break', 'work reaching 0 switches phase to break');
  assert.strictEqual(state.totalSeconds, 7, 'totalSeconds reflects the break total after transition');
  assert.strictEqual(state.remainingSeconds, 7, 'remainingSeconds resets to the break total');
  assert.strictEqual(state.status, 'running', 'session keeps running through the break');
  // banner is sourced from focus.js notify('Work'), not hardcoded here.
  assert.strictEqual(state.banner, expectedWorkBanner());
});

test('break reaching 0 sets status done (AC5a)', () => {
  const scheduler = makeManualScheduler();
  const session = createSession({ durations: { workSeconds: 2, breakSeconds: 2 }, scheduler });

  session.start();
  // Fire generously to drive both phases all the way to zero. fireTicks stops
  // when nothing is pending, so this cannot spin once the session is done.
  fireTicks(scheduler, 100);

  const state = session.getState();
  assert.strictEqual(state.status, 'done', 'break reaching 0 marks the session done');
  assert.strictEqual(state.phase, 'break', 'phase stays break when done');
  assert.strictEqual(state.remainingSeconds, 0, 'remaining is 0 when done');
});

test('start() from done restarts to phase work, status running, remaining = work total (AC5c)', () => {
  const scheduler = makeManualScheduler();
  const session = createSession({ durations: { workSeconds: 4, breakSeconds: 3 }, scheduler });

  session.start();
  fireTicks(scheduler, 100);
  assert.strictEqual(session.getState().status, 'done', 'precondition: session is done');

  session.start();
  const state = session.getState();
  assert.strictEqual(state.phase, 'work', 'restart returns to the work phase');
  assert.strictEqual(state.status, 'running', 'restart is running');
  assert.strictEqual(state.remainingSeconds, 4, 'restart begins at the configured work total');
  assert.strictEqual(state.totalSeconds, 4, 'totalSeconds reflects the work total on restart');
});

// --- parseDurations (AC5b) -------------------------------------------------

test('parseDurations maps valid env strings to { workSeconds, breakSeconds } numbers (AC5b)', () => {
  const result = parseDurations({ WORK_SECONDS: '10', BREAK_SECONDS: '5' });
  assert.deepStrictEqual(result, { workSeconds: 10, breakSeconds: 5 });
});

test('parseDurations falls back to defaults for non-numeric WORK_SECONDS (AC5b)', () => {
  const result = parseDurations({ WORK_SECONDS: 'abc' });
  assert.deepStrictEqual(result, { workSeconds: 1500, breakSeconds: 300 });
});

test('parseDurations falls back to defaults for negative WORK_SECONDS (AC5b)', () => {
  const result = parseDurations({ WORK_SECONDS: '-1' });
  assert.deepStrictEqual(result, { workSeconds: 1500, breakSeconds: 300 });
});

test('parseDurations falls back to defaults for zero WORK_SECONDS (AC5b)', () => {
  const result = parseDurations({ WORK_SECONDS: '0' });
  assert.deepStrictEqual(result, { workSeconds: 1500, breakSeconds: 300 });
});

test('parseDurations falls back to defaults for missing values (AC5b)', () => {
  const result = parseDurations({});
  assert.deepStrictEqual(result, { workSeconds: 1500, breakSeconds: 300 });
});
