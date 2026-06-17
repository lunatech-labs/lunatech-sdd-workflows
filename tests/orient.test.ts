import { describe, test, expect, afterEach } from 'vitest';
import { makeTempRepo, TempRepo } from './helpers/temp-repo';
import { describeGitState, gitSafetyCheck } from '../src/git-check';
import { orient, START_FRESH } from '../src/phases/orient';
import type { ChoiceResult, UI } from '../src/ui';

/**
 * Scripted UI: queued answers per method, every call recorded. Throws when a
 * method is called without a scripted answer, so tests that expect silence
 * fail loudly if the code asks anything.
 */
interface ScriptedUI extends UI {
  calls: {
    method: 'ask' | 'confirm' | 'select' | 'choose' | 'confirmWithNote';
    prompt: string;
    options?: string[];
  }[];
}

function scriptedUI(
  script: {
    confirms?: boolean[];
    selects?: string[];
    asks?: string[];
    confirmWithNotes?: { yes: boolean; note?: string }[];
    chooses?: ChoiceResult[];
  } = {},
): ScriptedUI {
  const confirms = [...(script.confirms ?? [])];
  const selects = [...(script.selects ?? [])];
  const asks = [...(script.asks ?? [])];
  const confirmWithNotes = [...(script.confirmWithNotes ?? [])];
  const chooses = [...(script.chooses ?? [])];
  const calls: ScriptedUI['calls'] = [];
  return {
    calls,
    async ask(question) {
      calls.push({ method: 'ask', prompt: question });
      const answer = asks.shift();
      if (answer === undefined) throw new Error(`unscripted ask: ${question}`);
      return answer;
    },
    async confirm(question) {
      calls.push({ method: 'confirm', prompt: question });
      const answer = confirms.shift();
      if (answer === undefined) throw new Error(`unscripted confirm: ${question}`);
      return answer;
    },
    async select(label, options) {
      calls.push({ method: 'select', prompt: label, options });
      const answer = selects.shift();
      if (answer === undefined) throw new Error(`unscripted select: ${label}`);
      return answer;
    },
    async readAnswer(message) {
      throw new Error(`unscripted readAnswer: ${message}`);
    },
    async choose(label, options) {
      calls.push({ method: 'choose', prompt: label, options });
      const answer = chooses.shift();
      if (answer === undefined) throw new Error(`unscripted choose: ${label}`);
      return answer;
    },
    async confirmWithNote(question) {
      calls.push({ method: 'confirmWithNote', prompt: question });
      const answer = confirmWithNotes.shift();
      if (answer === undefined) throw new Error(`unscripted confirmWithNote: ${question}`);
      return answer;
    },
  };
}

function specWithTasks(tasks: readonly string[]): string {
  return `# Feature Spec: Sample Feature

> Status: PLANNED
> Spec folder: specs/001-sample-feature/

## 1. Mission / Why

Solve the sample problem.

## 2. Outcome

A user can run the sample.

## 3. Scope

### In scope

- Sample thing

### Out of scope

- Other thing

## 4. Constraints & Decisions

- Language: TypeScript

## 5. Acceptance Criteria (how you'll verify it)

- [ ] AC1: Given input, when action, then result

## 6. Task Breakdown

${tasks.join('\n')}

## 7. Open Questions

- None.
`;
}

const MIXED_TASKS = [
  '1. [x] T1: Scaffold - verifies: AC1 - depends_on: none',
  '2. [ ] T2: Core module - verifies: AC1 - depends_on: T1',
  '3. [ ] T3: CLI wiring - verifies: AC1 - depends_on: T2',
];

const ALL_CHECKED_TASKS = [
  '1. [x] T1: Scaffold - verifies: AC1 - depends_on: none',
  '2. [x] T2: Core module - verifies: AC1 - depends_on: T1',
];

describe('git safety check (AC16)', () => {
  let repo: TempRepo;

  afterEach(async () => {
    await repo.cleanup();
  });

  test('clean repo with history passes silently, confirm never called', async () => {
    repo = await makeTempRepo({ git: true, commit: true, files: { 'a.txt': 'a\n' } });
    expect(await describeGitState(repo.root)).toBeNull();

    const ui = scriptedUI(); // no scripted confirms: any call would throw
    await expect(gitSafetyCheck(repo.root, ui.confirmWithNote)).resolves.toBe(true);
    expect(ui.calls).toHaveLength(0);
  });

  test('dirty working tree blocks without confirmation', async () => {
    repo = await makeTempRepo({ git: true, commit: true, files: { 'a.txt': 'a\n' } });
    await repo.writeFile('untracked.txt', 'dirty\n');

    expect(await describeGitState(repo.root)).toMatch(/uncommitted changes/);

    const ui = scriptedUI({ confirmWithNotes: [{ yes: false }] });
    await expect(gitSafetyCheck(repo.root, ui.confirmWithNote)).resolves.toBe(false);
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0].prompt).toMatch(/uncommitted changes/);
  });

  test('dirty working tree proceeds on explicit confirmation', async () => {
    repo = await makeTempRepo({ git: true, commit: true, files: { 'a.txt': 'a\n' } });
    await repo.writeFile('a.txt', 'modified\n');

    const ui = scriptedUI({ confirmWithNotes: [{ yes: true }] });
    await expect(gitSafetyCheck(repo.root, ui.confirmWithNote)).resolves.toBe(true);
    expect(ui.calls).toHaveLength(1);
  });

  test('a yes with an attached note still proceeds (note does not change the outcome)', async () => {
    repo = await makeTempRepo({ git: true, commit: true, files: { 'a.txt': 'a\n' } });
    await repo.writeFile('a.txt', 'modified\n');

    const ui = scriptedUI({ confirmWithNotes: [{ yes: true, note: 'rebuild first' }] });
    await expect(gitSafetyCheck(repo.root, ui.confirmWithNote)).resolves.toBe(true);
    expect(ui.calls).toHaveLength(1);
  });

  test('no git repository warns and requires confirmation', async () => {
    repo = await makeTempRepo();

    expect(await describeGitState(repo.root)).toMatch(/not a git repository/);

    const denied = scriptedUI({ confirmWithNotes: [{ yes: false }] });
    await expect(gitSafetyCheck(repo.root, denied.confirmWithNote)).resolves.toBe(false);
    expect(denied.calls[0].prompt).toMatch(/not a git repository/);

    const approved = scriptedUI({ confirmWithNotes: [{ yes: true }] });
    await expect(gitSafetyCheck(repo.root, approved.confirmWithNote)).resolves.toBe(true);
  });

  test('git repository with no commits warns and requires confirmation', async () => {
    repo = await makeTempRepo({ git: true });

    expect(await describeGitState(repo.root)).toMatch(/no commits/);

    const ui = scriptedUI({ confirmWithNotes: [{ yes: false }] });
    await expect(gitSafetyCheck(repo.root, ui.confirmWithNote)).resolves.toBe(false);
    expect(ui.calls[0].prompt).toMatch(/no commits/);
  });
});

describe('phase 0 orient (AC10)', () => {
  let repo: TempRepo;

  afterEach(async () => {
    await repo.cleanup();
  });

  test('no specs directory: fresh start, nothing asked', async () => {
    repo = await makeTempRepo({ git: true, commit: true });
    const ui = scriptedUI();
    await expect(orient(repo.root, ui)).resolves.toEqual({ mode: 'fresh' });
    expect(ui.calls).toHaveLength(0);
  });

  test('all tasks checked: fresh start, nothing asked', async () => {
    repo = await makeTempRepo({
      files: { 'specs/001-sample-feature/spec.md': specWithTasks(ALL_CHECKED_TASKS) },
    });
    const ui = scriptedUI();
    await expect(orient(repo.root, ui)).resolves.toEqual({ mode: 'fresh' });
    expect(ui.calls).toHaveLength(0);
  });

  test('spec with unchecked tasks offers resume and returns the first unchecked task', async () => {
    repo = await makeTempRepo({
      files: { 'specs/001-sample-feature/spec.md': specWithTasks(MIXED_TASKS) },
    });

    const ui = scriptedUI({ confirms: [true] });
    const result = await orient(repo.root, ui);

    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0].method).toBe('confirm');
    expect(ui.calls[0].prompt).toContain('specs/001-sample-feature/spec.md');
    expect(ui.calls[0].prompt).toContain('T2');

    expect(result.mode).toBe('resume');
    if (result.mode !== 'resume') throw new Error('expected resume');
    expect(result.specPath).toContain('specs/001-sample-feature/spec.md');
    expect(result.firstUnchecked.id).toBe('T2');
    expect(result.firstUnchecked.checked).toBe(false);
  });

  test('declining the resume offer starts fresh', async () => {
    repo = await makeTempRepo({
      files: { 'specs/001-sample-feature/spec.md': specWithTasks(MIXED_TASKS) },
    });
    const ui = scriptedUI({ confirms: [false] });
    await expect(orient(repo.root, ui)).resolves.toEqual({ mode: 'fresh' });
  });

  test('multiple resumable specs: select offers each plus fresh, returns the chosen spec', async () => {
    repo = await makeTempRepo({
      files: {
        'specs/001-sample-feature/spec.md': specWithTasks(MIXED_TASKS),
        'specs/002-other-feature/spec.md': specWithTasks([
          '1. [ ] T1: Other scaffold - verifies: AC1 - depends_on: none',
        ]),
      },
    });

    const probe = scriptedUI({ selects: [START_FRESH] });
    await expect(orient(repo.root, probe)).resolves.toEqual({ mode: 'fresh' });
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].method).toBe('select');
    const options = probe.calls[0].options ?? [];
    expect(options).toHaveLength(3);
    expect(options[0]).toContain('001-sample-feature');
    expect(options[1]).toContain('002-other-feature');
    expect(options[2]).toBe(START_FRESH);

    const chooser = scriptedUI({ selects: [options[1]] });
    const result = await orient(repo.root, chooser);
    expect(result.mode).toBe('resume');
    if (result.mode !== 'resume') throw new Error('expected resume');
    expect(result.specPath).toContain('specs/002-other-feature/spec.md');
    expect(result.firstUnchecked.id).toBe('T1');
  });
});
