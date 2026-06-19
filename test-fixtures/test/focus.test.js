'use strict';

// T2: Failing tests for argument parsing & validation.
//
// These tests are written test-first against the contract documented in
// plan.md ("Argument parsing & validation"):
//
//   parseArguments(argv) -> { command, work, break, help, error }
//
//   - work / break are integer MINUTES,
//   - defaults are work = 25, break = 5,
//   - invalid input sets a non-empty `error` string.
//
// They are EXPECTED TO FAIL until T3 implements parseArguments (which is
// currently a throwing stub). `break` is a reserved word, so it is accessed
// via bracket notation on the result object.

const test = require('node:test');
const assert = require('node:assert');

const { parseArguments, formatTime, runInterval, notify, runSession } = require('../focus.js');

test('start with no flags uses default durations (work 25, break 5)', () => {
  const result = parseArguments(['start']);
  assert.strictEqual(result.command, 'start');
  assert.strictEqual(result.work, 25);
  assert.strictEqual(result['break'], 5);
  assert.ok(!result.error, 'expected no error for valid default invocation');
});

test('flag overrides: --work 50 --break 10 produce work 50, break 10', () => {
  const result = parseArguments(['start', '--work', '50', '--break', '10']);
  assert.strictEqual(result.command, 'start');
  assert.strictEqual(result.work, 50);
  assert.strictEqual(result['break'], 10);
  assert.ok(!result.error, 'expected no error for valid overrides');
});

test('--work abc is invalid and sets a non-empty error', () => {
  const result = parseArguments(['start', '--work', 'abc']);
  assert.ok(
    typeof result.error === 'string' && result.error.length > 0,
    'expected a non-empty error string for non-numeric --work',
  );
});

test('--work -5 is invalid and sets a non-empty error', () => {
  const result = parseArguments(['start', '--work', '-5']);
  assert.ok(
    typeof result.error === 'string' && result.error.length > 0,
    'expected a non-empty error string for negative --work',
  );
});

test('--work 0 is invalid and sets a non-empty error', () => {
  const result = parseArguments(['start', '--work', '0']);
  assert.ok(
    typeof result.error === 'string' && result.error.length > 0,
    'expected a non-empty error string for zero --work',
  );
});

test('--break abc is invalid and sets a non-empty error', () => {
  const result = parseArguments(['start', '--break', 'abc']);
  assert.ok(
    typeof result.error === 'string' && result.error.length > 0,
    'expected a non-empty error string for non-numeric --break',
  );
});

// --- T4: formatTime unit tests ---------------------------------------------
//
// formatTime(totalSeconds) is a pure function returning a zero-padded MM:SS
// string. Minutes are not rolled into hours.

test('formatTime: 1500 seconds renders as "25:00"', () => {
  assert.strictEqual(formatTime(1500), '25:00');
});

test('formatTime: 65 seconds renders as "01:05" (zero-padded)', () => {
  assert.strictEqual(formatTime(65), '01:05');
});

test('formatTime: 0 seconds renders as "00:00"', () => {
  assert.strictEqual(formatTime(0), '00:00');
});

test('formatTime: 300 seconds renders as "05:00" (default break duration)', () => {
  assert.strictEqual(formatTime(300), '05:00');
});

test('formatTime: 59 seconds renders as "00:59"', () => {
  assert.strictEqual(formatTime(59), '00:59');
});

test('formatTime: 600 seconds renders as "10:00"', () => {
  assert.strictEqual(formatTime(600), '10:00');
});

test('formatTime: 3600 seconds renders as "60:00" (no roll into hours)', () => {
  assert.strictEqual(formatTime(3600), '60:00');
});

// --- T5: runInterval countdown tests (AC1) ---------------------------------
//
// runInterval({ label, totalSeconds, deps }) drives a single countdown whose
// only side effects are injected: deps.write (a string sink) and
// deps.scheduleTick (a tick scheduler). These tests inject a SYNCHRONOUS fake
// scheduler so no real time elapses: each scheduled callback fires immediately
// in a flush loop, so a "3 second" interval (or larger) completes in
// microseconds. There is NO real setInterval/setTimeout in the testable path.
//
// Counting scheme under test (matches the implementation comment): frames are
// rendered starting at totalSeconds and ticking down, INCLUDING the final
// 00:00 frame. So totalSeconds = 3 yields frames for 00:03, 00:02, 00:01,
// 00:00 (one update per second, reaching zero).

// Build a synchronous fake scheduler. Calls to scheduleTick(fn) enqueue fn;
// a flush() drains the queue, running each callback immediately. Because
// runInterval re-schedules from inside the callback, draining proceeds until
// the countdown resolves. Returns { scheduleTick, flush, count }.
function makeSyncScheduler() {
  const queue = [];
  let scheduledCount = 0;
  const scheduleTick = (fn) => {
    scheduledCount += 1;
    queue.push(fn);
    return { cancelled: false };
  };
  const flush = () => {
    // Drain synchronously; callbacks may enqueue further ticks.
    while (queue.length > 0) {
      const fn = queue.shift();
      fn();
    }
  };
  return {
    scheduleTick,
    flush,
    get count() {
      return scheduledCount;
    },
  };
}

test('runInterval renders one frame per second down to 00:00 (3s)', async () => {
  const writes = [];
  const scheduler = makeSyncScheduler();

  const promise = runInterval({
    label: 'Work',
    totalSeconds: 3,
    deps: { write: (s) => writes.push(s), scheduleTick: scheduler.scheduleTick },
  });

  // Drive the fake scheduler so all ticks fire synchronously.
  scheduler.flush();
  await promise;

  // At least one update per second, counting down to 00:00.
  assert.ok(writes.some((w) => w.includes('00:03')), 'expected a 00:03 frame');
  assert.ok(writes.some((w) => w.includes('00:02')), 'expected a 00:02 frame');
  assert.ok(writes.some((w) => w.includes('00:01')), 'expected a 00:01 frame');
  assert.ok(writes.some((w) => w.includes('00:00')), 'expected a final 00:00 frame');

  // Frames use carriage-return overwrite with the label and a trailing space.
  assert.ok(
    writes.every((w) => w.startsWith('\rWork: ')),
    'every frame should be a \\r-prefixed overwrite of the same line',
  );
});

test('runInterval resolves without using real time (large interval completes instantly)', async () => {
  const writes = [];
  const scheduler = makeSyncScheduler();
  const start = Date.now();

  const promise = runInterval({
    label: 'Work',
    totalSeconds: 1500, // a full 25-minute interval
    deps: { write: (s) => writes.push(s), scheduleTick: scheduler.scheduleTick },
  });

  scheduler.flush();
  await promise; // resolves only via the injected fake scheduler

  const elapsedMs = Date.now() - start;
  // 1500 frames + the initial frame = 1501 writes; reaches 00:00.
  assert.strictEqual(writes.length, 1501, 'expected one frame per second plus the initial frame');
  assert.ok(writes[writes.length - 1].includes('00:00'), 'last frame should be 00:00');
  assert.ok(elapsedMs < 500, `expected near-instant completion, took ${elapsedMs}ms`);
});

test('runInterval emits no bell or banner (notification is T6)', async () => {
  const writes = [];
  const scheduler = makeSyncScheduler();

  const promise = runInterval({
    label: 'Work',
    totalSeconds: 2,
    deps: { write: (s) => writes.push(s), scheduleTick: scheduler.scheduleTick },
  });

  scheduler.flush();
  await promise;

  const joined = writes.join('');
  assert.ok(!joined.includes('\x07'), 'runInterval must not emit the bell byte (T6)');
  assert.ok(!joined.includes('==='), 'runInterval must not print a banner (T6)');
});

// --- T6: notify + runSession transition tests (AC2, AC3) -------------------
//
// notify({ write, bell }, label) emits exactly one bell and one banner line
// for the given transition. runSession runs Work, then notify, then Break,
// driving the whole thing through an injected synchronous scheduler and fake
// sinks: a write sink, a fake bell counter. No real timers are used.
//
// To drive runSession synchronously across its async work->break boundary, the
// fake scheduler fires each scheduled callback on a microtask (a resolved
// Promise). This keeps everything off the real clock (no setTimeout/Interval)
// while still letting the second (Break) interval's ticks, which are only
// enqueued after the awaited Work interval resolves, drain to completion when
// the returned runSession promise is awaited.
function makeMicrotaskScheduler() {
  let scheduledCount = 0;
  const scheduleTick = (fn) => {
    scheduledCount += 1;
    // Defer via microtask: no real time elapses, but the await chain in
    // runSession progresses so subsequently-enqueued ticks still fire.
    Promise.resolve().then(fn);
    return { cancelled: false };
  };
  return {
    scheduleTick,
    get count() {
      return scheduledCount;
    },
  };
}

test('notify emits exactly one bell then a banner line, after a newline', () => {
  const writes = [];
  let bellCount = 0;

  notify(
    { write: (s) => writes.push(s), bell: () => { bellCount += 1; } },
    'Work',
  );

  assert.strictEqual(bellCount, 1, 'bell must fire exactly once');
  // First write moves off the carriage-return overwrite line.
  assert.strictEqual(writes[0], '\n', 'notify should write a newline first');
  const joined = writes.join('');
  assert.ok(joined.includes('==='), 'notify should print a banner line');
  assert.ok(/Work/i.test(joined), 'banner should reference the completed Work interval');
  assert.ok(joined.endsWith('\n'), 'banner line should end with a newline');
});

test('runSession: bell fires once, banner prints, then a Break countdown runs to 00:00 (AC2, AC3)', async () => {
  // Use small durations so the intervals are a handful of seconds. runInterval
  // takes totalSeconds = minutes * 60, so these fractional minutes keep the
  // frame counts tiny (work = 3s, break = 5s).
  const workMinutes = 3 / 60; // 3 seconds of work
  const breakMinutes = 5 / 60; // 5 seconds of break (its own configured duration)

  const writes = [];
  let bellCount = 0;
  let bellWriteIndex = -1;
  const scheduler = makeMicrotaskScheduler();

  await runSession({
    workMinutes,
    breakMinutes,
    deps: {
      write: (s) => {
        writes.push(s);
        return true;
      },
      scheduleTick: scheduler.scheduleTick,
      bell: () => {
        bellCount += 1;
        // Record where in the write stream the bell fired.
        bellWriteIndex = writes.length;
      },
    },
  });

  // AC2: bell fired exactly once at the work->break transition.
  assert.strictEqual(bellCount, 1, 'bell must fire exactly once per session');

  // AC2: a banner line printed at the transition.
  const joined = writes.join('');
  assert.ok(joined.includes('==='), 'a banner line must be printed at the transition');

  // The work countdown ran to 00:00 BEFORE the transition.
  const workFrames = writes.filter((w) => w.startsWith('\rWork: '));
  assert.ok(workFrames.some((w) => w.includes('00:03')), 'expected a Work 00:03 frame');
  assert.ok(workFrames.some((w) => w.includes('00:00')), 'expected the Work countdown to reach 00:00');

  // After the transition a BREAK countdown ran with the configured duration
  // and reached 00:00 (its own countdown).
  const breakFrames = writes.filter((w) => w.startsWith('\rBreak: '));
  assert.ok(breakFrames.length > 0, 'expected a Break countdown to run after the transition');
  assert.ok(breakFrames.some((w) => w.includes('00:05')), 'Break should honor the configured 5s duration');
  assert.ok(breakFrames.some((w) => w.includes('00:00')), 'expected the Break countdown to reach 00:00');

  // Ordering: all Work frames come before the bell/banner, all Break frames after.
  const firstBreakIndex = writes.findIndex((w) => w.startsWith('\rBreak: '));
  const lastWorkIndex = writes.map((w) => w.startsWith('\rWork: ')).lastIndexOf(true);
  const bannerIndex = writes.findIndex((w) => w.includes('==='));
  assert.ok(lastWorkIndex < bannerIndex, 'all Work frames must precede the banner');
  assert.ok(bannerIndex < firstBreakIndex, 'the banner must precede the first Break frame');
  // The bell fired between the last Work frame and the banner write.
  assert.ok(
    bellWriteIndex > lastWorkIndex && bellWriteIndex <= bannerIndex + 1,
    'the bell must fire at the work->break transition',
  );
});

test('runSession uses no real bell noise and no real timers (fast, synchronous)', async () => {
  const writes = [];
  let bellCount = 0;
  const scheduler = makeMicrotaskScheduler();
  const start = Date.now();

  await runSession({
    workMinutes: 2 / 60,
    breakMinutes: 2 / 60,
    deps: {
      write: (s) => writes.push(s),
      scheduleTick: scheduler.scheduleTick,
      bell: () => { bellCount += 1; },
    },
  });

  const elapsedMs = Date.now() - start;
  assert.strictEqual(bellCount, 1, 'exactly one bell per session');
  // The bell byte itself is never written by the fake bell, so the write
  // stream must not contain a stray bell byte.
  assert.ok(!writes.join('').includes('\x07'), 'no raw bell byte should leak into writes');
  assert.ok(elapsedMs < 500, `expected near-instant completion, took ${elapsedMs}ms`);
});
