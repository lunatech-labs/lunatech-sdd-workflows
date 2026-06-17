/**
 * Confirmed shell execution tool for the agent tool registry (AC6).
 *
 * Every call displays the exact command and blocks on the injected confirm
 * before anything executes. Denial returns a "denied by user" tool error
 * result, never a throw, so the agent loop hands it back to the model and
 * continues. On approval the command runs via child_process with cwd set to
 * the target repo root, capturing stdout, stderr, and the exit code.
 */
import { exec } from 'node:child_process';
import type { UI } from '../ui';
import type { ToolResult } from './fs-tools';

/** Tool error message returned when the user denies a command. */
export const DENIED_BY_USER = 'denied by user';

interface ExecCapture {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `command` through the shell with the given cwd, resolving with the
 * captured output and exit code. Rejects only on spawn-level failures
 * (e.g. missing cwd, output over maxBuffer), not on a non-zero exit.
 *
 * exec (shell) is deliberate: the input is an entire command line from the
 * model (pipes, redirects, "npm test" style strings), so execFile argument
 * arrays do not apply. Nothing is interpolated into the string, and the
 * guardrail is the per-command human confirmation in runCommand (AC6).
 */
function execute(command: string, cwd: string): Promise<ExecCapture> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (err, stdout, stderr) => {
      if (err === null) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      // A numeric code means the command ran and exited non-zero; anything
      // else (string code, killed by signal, buffer overflow) is a
      // spawn/transport failure.
      if (typeof err.code === 'number' && !err.killed) {
        resolve({ stdout, stderr, exitCode: err.code });
        return;
      }
      reject(err);
    });
  });
}

/**
 * The run_command tool: print the exact command, ask the injected confirm,
 * then execute on approval. Never throws on bad input or denial; returns
 * { ok: false, error } so the failure goes back to the model as a tool
 * error.
 */
export async function runCommand(
  repoRoot: string,
  args: { command: string },
  confirm: UI['confirm'],
): Promise<ToolResult> {
  const command = args?.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, error: 'run_command requires a non-empty "command" string' };
  }

  const approved = await confirm(
    `Agent wants to run this command in ${repoRoot}:\n  ${command}\nAllow?`,
  );
  if (!approved) {
    return { ok: false, error: DENIED_BY_USER };
  }

  try {
    const { stdout, stderr, exitCode } = await execute(command, repoRoot);
    return {
      ok: true,
      output: `exit code: ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `command failed to run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
