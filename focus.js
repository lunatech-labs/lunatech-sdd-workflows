#!/usr/bin/env node
'use strict';

// focus: a CLI Pomodoro timer (single-file, Node stdlib only).
//
// T1 scaffold: shebang, module guard, stub exports, and a fully-implemented
// help path. Timer logic, argument parsing/validation, and notifications are
// implemented in later tasks.

const DEFAULT_WORK_MINUTES = 25;
const DEFAULT_BREAK_MINUTES = 5;

// --- Stub exports (implemented in later tasks) -----------------------------

function parseArguments(/* argv */) {
  throw new Error('parseArguments not implemented yet (T3)');
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
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(helpText() + '\n');
    process.exit(0);
    return;
  }

  // Non-help paths (parsing, validation, running the timer) land in later tasks.
  throw new Error('focus: command not implemented yet');
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
