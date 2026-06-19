#!/usr/bin/env node
'use strict';

// T7 smoke harness (NOT part of the node:test suite; run manually with
// `node smoke/smoke.js`). It lives OUTSIDE test/ on purpose so the default
// `node --test` discovery does not pick it up: the real-timer path must never
// leak into the unit suite.
//
// This is the AC1/AC2 end-to-end proof on the REAL timer path. Real session
// durations are minutes, so we drive runSession with the SAME production-style
// deps (real setTimeout-based scheduleTick, a real write sink, the real bell
// byte) but on a SHORT tick and tiny totalSeconds, so a full Work -> bell +
// banner -> Break run completes in a couple of seconds instead of minutes.
//
// It does NOT change the CLI's minute-based --work/--break contract: it imports
// runSession directly and passes a short tickMs plus sub-minute "minutes".

const { runSession, buildProductionDeps } = require('../focus.js');

// 3 seconds of Work, 3 seconds of Break, ticking every 60ms on the real clock.
const TICK_MS = 60;
const WORK_SECONDS = 3;
const BREAK_SECONDS = 3;

// Real production deps, but with a short real-timer tick. Same setTimeout-based
// scheduleTick contract runInterval expects; the bell writes the real \x07 byte.
const deps = buildProductionDeps({ stdout: process.stdout, tickMs: TICK_MS });

runSession({
  workMinutes: WORK_SECONDS / 60,
  breakMinutes: BREAK_SECONDS / 60,
  deps,
})
  .then(() => {
    process.stdout.write('\n[smoke] session complete; exiting cleanly\n');
    // No explicit process.exit: if the timer handle were left pending the
    // event loop would hang. A clean natural exit proves the timer was cleared.
  })
  .catch((err) => {
    process.stderr.write(`[smoke] error: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
