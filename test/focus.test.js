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

const { parseArguments, formatTime } = require('../focus.js');

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
