/**
 * Git safety check run at startup (AC16).
 *
 * Inspects the target repo with `git status --porcelain` and
 * `git rev-parse HEAD`. Three states produce a warning that requires the
 * injected confirm before the orchestrator may proceed: no git repository,
 * a repository with no commits, and a dirty working tree. A clean repo with
 * history passes silently (confirm is never called).
 *
 * The check never throws on these states; it returns false when the user
 * declines so the caller can exit cleanly.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UI } from './ui';

const execFileAsync = promisify(execFile);

async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot });
  return stdout;
}

/**
 * Describe the unsafe git state of `repoRoot`, or return null when the repo
 * is clean and has at least one commit.
 */
export async function describeGitState(repoRoot: string): Promise<string | null> {
  let status: string;
  try {
    status = await git(repoRoot, 'status', '--porcelain');
  } catch {
    return 'this directory is not a git repository (no history to fall back on)';
  }

  try {
    await git(repoRoot, 'rev-parse', 'HEAD');
  } catch {
    return 'this git repository has no commits yet (no history to fall back on)';
  }

  if (status.trim() !== '') {
    return 'the working tree has uncommitted changes';
  }

  return null;
}

/**
 * Run the startup git safety check. Returns true when it is safe to proceed:
 * either the repo is clean with history, or the user explicitly confirmed
 * the warning. Returns false when the user declines; the caller should then
 * exit cleanly without doing anything else.
 */
export async function gitSafetyCheck(
  repoRoot: string,
  confirm: UI['confirm'],
): Promise<boolean> {
  const warning = await describeGitState(repoRoot);
  if (warning === null) return true;
  return confirm(
    `Warning: ${warning}. Agents will modify files in ${repoRoot}. Proceed anyway?`,
  );
}
