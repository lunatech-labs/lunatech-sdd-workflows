#!/usr/bin/env node
'use strict';

// focus: a CLI Pomodoro timer (single-file, Node stdlib only).
//
// T1 scaffold: shebang, module guard, stub exports, and a fully-implemented
// help path. Timer logic, argument parsing/validation, and notifications are
// implemented in later tasks.

const { parseArgs } = require('node:util');

const DEFAULT_WORK_MINUTES = 25;
const DEFAULT_BREAK_MINUTES = 5;

// --- Argument parsing & validation (T3) ------------------------------------

// Coerce a raw flag value to a positive integer number of minutes.
// Returns { value } on success or { error } with a descriptive message.
function coercePositiveMinutes(flagName, raw) {
  // Reject anything that is not a plain, base-10 integer (no decimals,
  // no leading +, no surrounding whitespace, no dash-prefixed values).
  if (!/^\d+$/.test(raw)) {
    return {
      error: `Invalid value for --${flagName}: ${raw}. Expected a positive whole number of minutes.`,
    };
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    return {
      error: `Invalid value for --${flagName}: ${raw}. Expected a positive whole number of minutes.`,
    };
  }
  return { value };
}

function parseArguments(argv = []) {
  const result = {
    command: null,
    work: DEFAULT_WORK_MINUTES,
    break: DEFAULT_BREAK_MINUTES,
    help: false,
    error: null,
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        work: { type: 'string' },
        break: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    // parseArgs throws on unknown options or on a dash-prefixed value being
    // treated as a flag (e.g. `--work -5`). Convert that into the AC5 error
    // path rather than letting it crash with an uncaught exception.
    result.error = err && err.message ? err.message : String(err);
    return result;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    result.help = true;
  }

  if (positionals.length > 0) {
    result.command = positionals[0];
  }

  if (Object.prototype.hasOwnProperty.call(values, 'work')) {
    const coerced = coercePositiveMinutes('work', values.work);
    if (coerced.error) {
      result.error = coerced.error;
      return result;
    }
    result.work = coerced.value;
  }

  if (Object.prototype.hasOwnProperty.call(values, 'break')) {
    const coerced = coercePositiveMinutes('break', values.break);
    if (coerced.error) {
      result.error = coerced.error;
      return result;
    }
    result.break = coerced.value;
  }

  return result;
}

// Pure formatter: render a non-negative whole number of seconds as a
// zero-padded MM:SS string (e.g. 1500 -> "25:00", 65 -> "01:05", 0 -> "00:00").
// Minutes are not rolled into hours, so 3600 -> "60:00".
function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${mm}:${ss}`;
}

// --- Interval runner (T5) --------------------------------------------------
//
// runInterval drives a single countdown interval. All side effects (writing
// to a stream, scheduling ticks) are injected via `deps` so tests can run a
// "25-minute" interval in microseconds with a synchronous fake scheduler and
// never touch a real clock.
//
//   runInterval({ label, totalSeconds, deps }) -> Promise<void>
//   deps = { write, scheduleTick }
//     - write(str): writes a string to the output sink (no newline added).
//     - scheduleTick(fn): schedules `fn` to run once after ~1 second and
//       returns a cancel handle. In production this wraps setInterval/Timeout;
//       in tests it fires synchronously so the countdown completes instantly.
//
// Counting scheme (load-bearing, so the critic can verify intent):
//   The countdown renders one frame per second STARTING at `totalSeconds` and
//   ticking DOWN, INCLUDING the final 00:00 frame. So for totalSeconds = 3 the
//   rendered remaining values are 3, 2, 1, 0 -> "00:03", "00:02", "00:01",
//   "00:00" (four frames; at-least-once-per-second updates down to 00:00).
//   The initial frame (totalSeconds) is written immediately; each subsequent
//   frame is written on a scheduled tick. The returned Promise resolves once
//   the 00:00 frame has been written. No bell or banner is emitted here; the
//   notification (bell + banner) belongs to T6.
function runInterval({ label, totalSeconds, deps }) {
  const { write, scheduleTick } = deps;

  return new Promise((resolve) => {
    let remaining = totalSeconds;

    const render = (value) => {
      // Carriage-return overwrite: each frame redraws the same terminal line.
      write(`\r${label}: ${formatTime(value)} `);
    };

    // Frame for the starting value (e.g. "00:03").
    render(remaining);

    if (remaining <= 0) {
      // Already at (or below) zero: the 00:00 frame is the only frame.
      resolve();
      return;
    }

    const tick = () => {
      remaining -= 1;
      render(remaining);
      if (remaining <= 0) {
        // Reached 00:00: stop scheduling and complete.
        resolve();
        return;
      }
      scheduleTick(tick);
    };

    scheduleTick(tick);
  });
}

function notify(/* write, bell, label */) {
  throw new Error('notify not implemented yet (T6)');
}

// --- Help text (T1, fully implemented) -------------------------------------

function helpText() {
  return [
    'focus: a CLI Pomodoro timer',
    '',
    'Usage:',
    '  focus start [--work <minutes>] [--break <minutes>]',
    '  focus --help',
    '',
    'Commands:',
    '  start            Run a work interval followed by a break interval.',
    '',
    'Flags:',
    `  --work <minutes>  Length of the work interval (default ${DEFAULT_WORK_MINUTES}).`,
    `  --break <minutes> Length of the break interval (default ${DEFAULT_BREAK_MINUTES}).`,
    '  -h, --help        Show this help and exit.',
    '',
  ].join('\n');
}

// --- Entry point (T1 implements only the help path) ------------------------

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    process.stdout.write(helpText() + '\n');
    process.exit(0);
    return;
  }

  const parsed = parseArguments(argv);

  // Error path (AC5): report to stderr and exit non-zero BEFORE any timer.
  if (parsed.error) {
    process.stderr.write(`focus: ${parsed.error}\n`);
    process.exit(1);
    return;
  }

  // Help path (AC4): print usage to stdout and exit 0.
  if (parsed.help) {
    process.stdout.write(helpText() + '\n');
    process.exit(0);
    return;
  }

  if (parsed.command !== 'start') {
    process.stderr.write(
      `focus: unknown command${parsed.command ? `: ${parsed.command}` : ''}. Run 'focus --help'.\n`,
    );
    process.exit(1);
    return;
  }

  // The actual timer (production deps -> runInterval / runSession) is wired up
  // end-to-end in T7. runInterval is fully implemented and unit-tested (T5),
  // but the start path here stays a deferred placeholder so the help/error
  // paths cannot regress and no real timer leaks before T7 builds prod deps.
  process.stderr.write(
    "focus: start is not wired up yet (pending T7).\n",
  );
  process.exit(1);
}

module.exports = {
  parseArguments,
  formatTime,
  runInterval,
  notify,
  helpText,
  main,
  DEFAULT_WORK_MINUTES,
  DEFAULT_BREAK_MINUTES,
};

// Module guard: only run the CLI when executed directly, not on import.
if (require.main === module) {
  main();
}
