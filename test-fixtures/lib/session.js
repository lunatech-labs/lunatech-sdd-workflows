'use strict';

// Session model for the Focus Web UI (spec 002-focus-web-ui, task T2).
//
// This is the server-side, transport-agnostic timer state. It models the
// idle/running/paused/done lifecycle across a work phase followed by a break
// phase, and it drives BOTH phase countdowns through focus.js's runInterval
// (using an injected scheduler) rather than maintaining an independent
// per-second counter. The work-to-break transition banner text is sourced from
// focus.js's notify, not hardcoded here. MM:SS values are produced by
// focus.js's formatTime. See plan.md "focus.js reuse" for the rationale.
//
// Contract (the binding tests live in test/session.test.js):
//
//   createSession({ durations, scheduler }) -> session
//     durations: { workSeconds, breakSeconds } (optional; default 1500 / 300).
//     scheduler: an injected tick driver exposing
//       scheduleTick(fn) -> { cancel }   (stores fn as the single pending tick;
//         this is passed straight into runInterval as deps.scheduleTick so the
//         per-second decrement is DRIVEN by runInterval's own tick)
//       tick()    -> fires the single pending tick, if any
//       pending() -> boolean, whether a tick is currently pending
//
//   session.getState() -> { remainingSeconds, totalSeconds, phase, status, banner }
//   session.start()  -> idle/paused -> running; done -> restart at work.
//   session.pause()  -> running -> paused; freeze remaining; clear pending tick.
//   session.reset()  -> any -> idle; phase work; remaining = workSeconds; banner null.

const focus = require('../focus.js');

const DEFAULT_WORK_SECONDS = 1500;
const DEFAULT_BREAK_SECONDS = 300;

// Parse a single env value as a positive whole number of seconds. Mirrors the
// validation shape of focus.js's coercePositiveMinutes: only a base-10 string
// of digits that parses to an integer greater than zero is accepted. Anything
// else (non-numeric, negative, zero, missing) is rejected so the caller can
// fall back to the default.
function parsePositiveSeconds(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

// Pure duration config helper. Reads WORK_SECONDS and BREAK_SECONDS from an env
// object and returns { workSeconds, breakSeconds }. Invalid or missing values
// fall back to the defaults (1500 work / 300 break) with a console.warn naming
// the offending variable, and never throw.
function parseDurations(env = {}) {
  const work = parsePositiveSeconds(env.WORK_SECONDS);
  const breakValue = parsePositiveSeconds(env.BREAK_SECONDS);

  if (env.WORK_SECONDS !== undefined && work === null) {
    console.warn(
      `Invalid WORK_SECONDS: ${env.WORK_SECONDS}. Falling back to ${DEFAULT_WORK_SECONDS}.`,
    );
  }
  if (env.BREAK_SECONDS !== undefined && breakValue === null) {
    console.warn(
      `Invalid BREAK_SECONDS: ${env.BREAK_SECONDS}. Falling back to ${DEFAULT_BREAK_SECONDS}.`,
    );
  }

  return {
    workSeconds: work === null ? DEFAULT_WORK_SECONDS : work,
    breakSeconds: breakValue === null ? DEFAULT_BREAK_SECONDS : breakValue,
  };
}

// Obtain the work-to-break transition banner line from focus.js's notify, with
// a capturing write sink and a no-op bell. We do NOT hardcode the banner string
// so the text stays sourced from focus.js (AC5a / AC6).
function workCompleteBanner() {
  const lines = [];
  focus.notify({ write: (s) => lines.push(s), bell: () => {} }, 'Work');
  return lines
    .join('')
    .split('\n')
    .find((l) => l.includes('==='));
}

// Extract the remaining seconds from a frame that runInterval rendered. Frames
// look like "\rWork: MM:SS " (see focus.js runInterval/formatTime). We parse the
// MM:SS back to seconds so the authoritative remaining value flows from the same
// frame runInterval drives, rather than from a parallel counter.
function remainingFromFrame(frame) {
  const match = /(\d{2}):(\d{2})/.exec(frame);
  if (!match) {
    return null;
  }
  const minutes = Number.parseInt(match[1], 10);
  const seconds = Number.parseInt(match[2], 10);
  return minutes * 60 + seconds;
}

function createSession({ durations, scheduler } = {}) {
  const workSeconds =
    durations && durations.workSeconds !== undefined
      ? durations.workSeconds
      : DEFAULT_WORK_SECONDS;
  const breakSeconds =
    durations && durations.breakSeconds !== undefined
      ? durations.breakSeconds
      : DEFAULT_BREAK_SECONDS;

  // Mutable snapshot fields.
  let phase = 'work';
  let status = 'idle';
  let totalSeconds = workSeconds;
  let remainingSeconds = workSeconds;
  let banner = null;

  // The injected scheduler is the single source of pending ticks. runInterval
  // calls scheduler.scheduleTick(fn) to register the next tick; the test (or the
  // production interval) fires scheduler.tick() to advance. We never arm a timer
  // of our own here, so pause/reset just have to cancel the pending tick.
  let activeCancel = null;

  // Drive a single phase's countdown through focus.js's runInterval. The write
  // sink parses each rendered frame so remainingSeconds tracks exactly what
  // runInterval is counting. onComplete fires synchronously when the 00:00 frame
  // is written (we cannot rely on runInterval's resolved Promise here because
  // the tests fire ticks synchronously and never await microtasks).
  function runPhase(label, phaseTotalSeconds, onComplete) {
    let completed = false;

    const write = (frame) => {
      const value = remainingFromFrame(frame);
      if (value !== null) {
        remainingSeconds = value;
      }
      if (value === 0 && !completed) {
        completed = true;
        // The 00:00 frame was just rendered; runInterval will not schedule a
        // further tick for this phase, so the boundary handling happens now.
        onComplete();
      }
    };

    // Wrap scheduleTick so we can track the cancel handle for the currently
    // pending tick (used by pause/reset). The fn itself is passed straight
    // through to the injected scheduler, so counting genuinely flows through
    // runInterval's own tick.
    const scheduleTick = (fn) => {
      const handle = scheduler.scheduleTick(fn);
      activeCancel = handle && handle.cancel ? handle.cancel : null;
      return handle;
    };

    // runInterval renders the starting frame immediately (which sets
    // remainingSeconds via the write sink) and schedules subsequent ticks.
    focus.runInterval({
      label,
      totalSeconds: phaseTotalSeconds,
      deps: { write, scheduleTick },
    });
  }

  function startBreakPhase() {
    phase = 'break';
    totalSeconds = breakSeconds;
    banner = workCompleteBanner();
    runPhase('Break', breakSeconds, () => {
      // Break reaching 0 ends the session.
      status = 'done';
    });
  }

  function startWorkPhase() {
    phase = 'work';
    totalSeconds = workSeconds;
    banner = null;
    runPhase('Work', workSeconds, () => {
      // Work reaching 0 transitions to the break phase and keeps running.
      startBreakPhase();
    });
  }

  function clearPendingTick() {
    if (activeCancel) {
      activeCancel();
    }
    activeCancel = null;
  }

  function start() {
    if (status === 'running') {
      return;
    }

    if (status === 'done') {
      // Restart from the work phase at the configured durations (AC5c).
      reset();
    }

    if (status === 'paused') {
      // Resume the current phase from the frozen remaining value. Re-driving
      // runInterval from the current remaining keeps the countdown flowing
      // through runInterval's tick rather than a manual decrement.
      status = 'running';
      resumeCurrentPhase();
      return;
    }

    // status === 'idle': begin the work phase.
    status = 'running';
    startWorkPhase();
  }

  function resumeCurrentPhase() {
    const label = phase === 'work' ? 'Work' : 'Break';
    const onComplete =
      phase === 'work'
        ? () => startBreakPhase()
        : () => {
            status = 'done';
          };
    runPhase(label, remainingSeconds, onComplete);
  }

  function pause() {
    if (status !== 'running') {
      return;
    }
    status = 'paused';
    // Freeze remaining by dropping the pending tick so nothing advances.
    clearPendingTick();
  }

  function reset() {
    clearPendingTick();
    phase = 'work';
    status = 'idle';
    totalSeconds = workSeconds;
    remainingSeconds = workSeconds;
    banner = null;
  }

  function getState() {
    return {
      remainingSeconds,
      totalSeconds,
      phase,
      status,
      banner,
    };
  }

  return { getState, start, pause, reset };
}

module.exports = { createSession, parseDurations };
