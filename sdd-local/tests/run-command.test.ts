/**
 * Tests for the confirmed run-command tool (AC6): the command is displayed
 * and nothing executes until the user confirms; denial returns a
 * "denied by user" tool error result, not a throw.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DENIED_BY_USER, runCommand } from '../src/tools/run-command';
import { makeTempRepo, type TempRepo } from './helpers/temp-repo';

/** Scripted confirm that records every question it was asked. */
function scriptedConfirm(answer: boolean) {
  const questions: string[] = [];
  const confirm = async (question: string): Promise<boolean> => {
    questions.push(question);
    return answer;
  };
  return { confirm, questions };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('runCommand', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await makeTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('on denial returns a "denied by user" error result and executes nothing', async () => {
    const sideEffect = path.join(repo.root, 'created-by-command.txt');
    const command = `echo executed > ${JSON.stringify(sideEffect)}`;
    const { confirm, questions } = scriptedConfirm(false);

    const result = await runCommand(repo.root, { command }, confirm);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(DENIED_BY_USER);
    }
    // The command never ran: the side-effect file it would have created
    // does not exist.
    expect(await exists(sideEffect)).toBe(false);
    // The exact command was shown to the user before the decision.
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain(command);
  });

  it('on approval executes the command and returns captured output', async () => {
    const { confirm, questions } = scriptedConfirm(true);

    const result = await runCommand(repo.root, { command: 'echo hello-from-tool' }, confirm);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('exit code: 0');
      expect(result.output).toContain('hello-from-tool');
    }
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('echo hello-from-tool');
  });

  it('on approval runs with cwd = repo root (side-effect file lands in the repo)', async () => {
    const { confirm } = scriptedConfirm(true);

    const result = await runCommand(
      repo.root,
      { command: 'echo executed > created-by-command.txt' },
      confirm,
    );

    expect(result.ok).toBe(true);
    expect(await exists(path.join(repo.root, 'created-by-command.txt'))).toBe(true);
    expect((await repo.readFile('created-by-command.txt')).trim()).toBe('executed');
  });

  it('captures stderr and a non-zero exit code without throwing', async () => {
    const { confirm } = scriptedConfirm(true);

    const result = await runCommand(
      repo.root,
      { command: 'echo oops >&2; exit 3' },
      confirm,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('exit code: 3');
      expect(result.output).toContain('oops');
    }
  });

  it('rejects a missing or empty command without asking for confirmation', async () => {
    const { confirm, questions } = scriptedConfirm(true);

    const empty = await runCommand(repo.root, { command: '   ' }, confirm);
    expect(empty.ok).toBe(false);

    const missing = await runCommand(
      repo.root,
      { command: undefined as unknown as string },
      confirm,
    );
    expect(missing.ok).toBe(false);

    expect(questions).toHaveLength(0);
  });

  it('returns an error result, not a throw, when the command cannot be spawned', async () => {
    const { confirm } = scriptedConfirm(true);
    const missingCwd = path.join(repo.root, 'no-such-dir');

    const result = await runCommand(missingCwd, { command: 'echo hi' }, confirm);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('command failed to run');
    }
  });
});
