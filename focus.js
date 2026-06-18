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

function formatTime(/* totalSeconds */) {
  throw new Error('formatTime not implemented yet (T4)');
}

function runInterval(/* options */) {
  throw new Error('runInterval not implemented yet (T5)');
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

  // The actual timer (runInterval / runSession) is wired up in later tasks.
  // Keep the error/help paths intact; the start path is still a stub here.
  runInterval({ work: parsed.work, break: parsed.break });
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
