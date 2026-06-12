import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { startMockOllama, MockOllamaServer, MockToolCall } from './helpers/mock-ollama';
import { makeTempRepo, TempRepo } from './helpers/temp-repo';
import {
  implement,
  ImplementOptions,
  MAX_TASK_RETRIES,
  DRIFT_CONTINUE,
  DRIFT_AMEND,
  DRIFT_ABORT,
} from '../src/phases/implement';
import type { ChatMessage } from '../src/ollama';
import type { UI } from '../src/ui';

/** UI with scripted answers that records every prompt it was shown. */
interface ScriptedUI extends UI {
  asked: string[];
  selected: Array<{ label: string; options: string[] }>;
}

function scriptedUI(script: { asks?: string[]; selects?: string[] } = {}): ScriptedUI {
  const asks = [...(script.asks ?? [])];
  const selects = [...(script.selects ?? [])];
  const ui: ScriptedUI = {
    asked: [],
    selected: [],
    async ask(question) {
      ui.asked.push(question);
      const answer = asks.shift();
      if (answer === undefined) throw new Error('scriptedUI: no scripted ask answer left');
      return answer;
    },
    async confirm() {
      throw new Error('scriptedUI: confirm is not scripted (no command runs in these tests)');
    },
    async select(label, options) {
      ui.selected.push({ label, options });
      const answer = selects.shift();
      if (answer === undefined) throw new Error('scriptedUI: no scripted select answer left');
      return answer;
    },
    async readAnswer() {
      throw new Error('scriptedUI: readAnswer is not scripted');
    },
  };
  return ui;
}

function call(name: string, args: Record<string, unknown>): MockToolCall {
  return { function: { name, arguments: args } };
}

const SPEC_REL_PATH = 'specs/001-demo/spec.md';
const PLAN_REL_PATH = 'specs/001-demo/plan.md';
const JOURNAL_REL_PATH = 'specs/001-demo/journal.md';

const TASK_LINES = [
  '1. [ ] T1: Set up the demo scaffold - verifies: AC1 - depends_on: none',
  '2. [ ] T2: Make the demo work - verifies: AC1 - depends_on: T1',
];

/** A spec.md following the vendored template structure, Status PLANNED by
 * default (the Gate 2 approved state the IMPLEMENT phase starts from). */
function demoSpec(
  overrides: { status?: string; section6?: string[] } = {},
): string {
  return [
    '# Feature Spec: Demo Feature',
    '',
    `> Status: ${overrides.status ?? 'PLANNED'}`,
    '> Spec folder: specs/001-demo/',
    '',
    '## 1. Mission / Why',
    '',
    'Build a demo feature so the IMPLEMENT phase can be tested.',
    '',
    '## 2. Outcome',
    '',
    'A user can run the demo and see it work.',
    '',
    '## 3. Scope',
    '',
    '### In scope',
    '',
    '- The demo',
    '',
    '### Out of scope',
    '',
    '- Everything else',
    '',
    '## 4. Constraints & Decisions',
    '',
    '- Language / framework: TypeScript',
    '',
    "## 5. Acceptance Criteria (how you'll verify it)",
    '',
    '- [ ] AC1: Given a demo, when it runs, then it works.',
    '',
    '## 6. Task Breakdown',
    '',
    ...(overrides.section6 ?? TASK_LINES),
    '',
    '## 7. Open Questions',
    '',
    '- None.',
    '',
  ].join('\n');
}

const PLAN_CONTENT =
  '# Plan: Demo Feature\n\n## Per-task detail\n\n- T1: scaffold.\n- T2: make it work.\n';

/** One implementer dispatch: a single chat reply carrying the report. */
function implementerReport(
  taskId: string,
  overrides: { status?: string; details?: string; changes?: string } = {},
) {
  return {
    tool_calls: [
      call('report', {
        task_id: taskId,
        changes: overrides.changes ?? `src/demo-${taskId}.ts: created`,
        verification: 'npm test: pass',
        status: overrides.status ?? 'CLEAN',
        ...(overrides.details !== undefined ? { details: overrides.details } : {}),
      }),
    ],
  };
}

/** One critic dispatch: a single chat reply carrying the verdict. */
function criticVerdict(verdict: string, details: string) {
  return { tool_calls: [call('report', { verdict, details })] };
}

describe('implement loop', () => {
  let mock: MockOllamaServer;
  let repo: TempRepo;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(() => mock.close());

  beforeEach(async () => {
    mock.reset();
    repo = await makeTempRepo({
      files: { [SPEC_REL_PATH]: demoSpec(), [PLAN_REL_PATH]: PLAN_CONTENT },
    });
  });

  afterEach(() => repo.cleanup());

  function options(
    ui: UI,
    progress: string[] = [],
    overrides: Partial<ImplementOptions> = {},
  ): ImplementOptions {
    return {
      repoRoot: repo.root,
      specPath: path.join(repo.root, SPEC_REL_PATH),
      planPath: path.join(repo.root, PLAN_REL_PATH),
      baseUrl: mock.baseUrl,
      implementerModel: 'mock-implementer',
      criticModel: 'mock-critic',
      ui,
      onProgress: line => progress.push(line),
      ...overrides,
    };
  }

  /** Messages of the nth recorded /api/chat request. */
  function chatMessages(index: number): ChatMessage[] {
    return (mock.chatRequests[index] as { messages: ChatMessage[] }).messages;
  }

  /** First user message (the dispatch context) of the nth chat request. */
  function dispatchContext(index: number): string {
    const message = chatMessages(index)[1];
    expect(message.role).toBe('user');
    return message.content;
  }

  function journal(): Promise<string> {
    return repo.readFile(JOURNAL_REL_PATH);
  }

  test('PASS path: tasks run sequentially, each PASS ticks and journals (AC3)', async () => {
    mock.script([
      implementerReport('T1'),
      criticVerdict('PASS', 'T1 verified: scaffold present, tests pass.'),
      implementerReport('T2'),
      criticVerdict('PASS', 'T2 verified: demo works.'),
    ]);
    const ui = scriptedUI();
    const progress: string[] = [];

    const result = await implement(options(ui, progress));

    expect(result).toEqual({ outcome: 'complete' });
    expect(mock.pendingReplies).toBe(0);

    // Strictly sequential: implementer T1, critic T1, implementer T2, critic T2.
    expect(mock.chatRequests).toHaveLength(4);
    expect(dispatchContext(0)).toContain('Task ID: T1');
    expect(dispatchContext(0)).toContain(SPEC_REL_PATH);
    expect(dispatchContext(0)).toContain(PLAN_REL_PATH);
    expect(dispatchContext(1)).toContain('Task ID: T1');
    expect(dispatchContext(1)).toContain('src/demo-T1.ts: created');
    expect(dispatchContext(2)).toContain('Task ID: T2');
    expect(dispatchContext(3)).toContain('Task ID: T2');

    // Different models drive the two roles.
    expect((mock.chatRequests[0] as { model: string }).model).toBe('mock-implementer');
    expect((mock.chatRequests[1] as { model: string }).model).toBe('mock-critic');

    // Both checkboxes ticked; status set to IN PROGRESS at the start.
    const spec = await repo.readFile(SPEC_REL_PATH);
    expect(spec).toContain('> Status: IN PROGRESS');
    expect(spec).toContain('1. [x] T1: Set up the demo scaffold');
    expect(spec).toContain('2. [x] T2: Make the demo work');

    // Both verdicts journaled.
    const entries = await journal();
    expect(entries).toContain('T1: critic verdict PASS');
    expect(entries).toContain('T1 verified: scaffold present, tests pass.');
    expect(entries).toContain('T2: critic verdict PASS');

    // One-line progress note per passed task.
    expect(progress).toContain('Task T1: critic PASS, checkbox ticked.');
    expect(progress).toContain('Task T2: critic PASS, checkbox ticked.');

    // No drift prompts, no gates: the UI was never consulted.
    expect(ui.selected).toHaveLength(0);
  });

  test('already-checked tasks are skipped: the loop resumes from the first unchecked task', async () => {
    await repo.writeFile(
      SPEC_REL_PATH,
      demoSpec({
        status: 'IN PROGRESS',
        section6: [
          '1. [x] T1: Set up the demo scaffold - verifies: AC1 - depends_on: none',
          '2. [ ] T2: Make the demo work - verifies: AC1 - depends_on: T1',
        ],
      }),
    );
    mock.script([implementerReport('T2'), criticVerdict('PASS', 'T2 verified.')]);

    const result = await implement(options(scriptedUI()));

    expect(result).toEqual({ outcome: 'complete' });
    expect(mock.chatRequests).toHaveLength(2);
    expect(dispatchContext(0)).toContain('Task ID: T2');
  });

  test('critic FAIL re-dispatches the implementer with the failures, then PASS completes', async () => {
    mock.script([
      implementerReport('T1'),
      criticVerdict('FAIL', 'T1 failure: the scaffold misses tsconfig (AC1).'),
      implementerReport('T1', { changes: 'src/demo-T1.ts: fixed, tsconfig.json: added' }),
      criticVerdict('PASS', 'T1 verified on retry.'),
      implementerReport('T2'),
      criticVerdict('PASS', 'T2 verified.'),
    ]);

    const result = await implement(options(scriptedUI()));

    expect(result).toEqual({ outcome: 'complete' });
    expect(mock.chatRequests).toHaveLength(6);

    // The retry context carried the critic's specific failures.
    const retryContext = dispatchContext(2);
    expect(retryContext).toContain('Task ID: T1');
    expect(retryContext).toContain('FAIL');
    expect(retryContext).toContain('T1 failure: the scaffold misses tsconfig (AC1).');

    const spec = await repo.readFile(SPEC_REL_PATH);
    expect(spec).toContain('1. [x] T1:');
    expect(spec).toContain('2. [x] T2:');
  });

  test('FAIL-FAIL-FAIL escalates after exactly 2 retries and shows the critic report (AC4)', async () => {
    mock.script([
      implementerReport('T1'),
      criticVerdict('FAIL', 'attempt 1 failure: tests fail.'),
      implementerReport('T1'),
      criticVerdict('FAIL', 'attempt 2 failure: tests still fail.'),
      implementerReport('T1'),
      criticVerdict('FAIL', 'attempt 3 failure: tests fail for the third time.'),
    ]);
    const ui = scriptedUI();
    const progress: string[] = [];

    const result = await implement(options(ui, progress));

    expect(result).toEqual({
      outcome: 'escalated',
      taskId: 'T1',
      criticDetails: 'attempt 3 failure: tests fail for the third time.',
    });

    // Exactly 1 initial attempt plus 2 retries: 3 implementer and 3 critic
    // dispatches, then a hard stop. T2 was never dispatched.
    expect(mock.chatRequests).toHaveLength(6);
    expect(mock.pendingReplies).toBe(0);
    expect(dispatchContext(2)).toContain('attempt 1 failure: tests fail.');
    expect(dispatchContext(4)).toContain('attempt 2 failure: tests still fail.');

    // The task stays unchecked and the escalation is journaled.
    const spec = await repo.readFile(SPEC_REL_PATH);
    expect(spec).toContain('1. [ ] T1:');
    expect(spec).toContain('2. [ ] T2:');
    const entries = await journal();
    expect(entries).toContain(`T1: critic verdict FAIL after ${MAX_TASK_RETRIES} retries`);
    expect(entries).toContain('attempt 3 failure: tests fail for the third time.');

    // The critic's report was shown through the injectable output.
    expect(progress.join('\n')).toContain('attempt 3 failure: tests fail for the third time.');

    // Escalation is a stop, not a drift decision: no UI prompt.
    expect(ui.selected).toHaveLength(0);
  });

  test('implementer DRIFT halts the loop and journals before the user prompt; abort stops (AC12)', async () => {
    mock.script([
      implementerReport('T1', {
        status: 'DRIFT',
        details: 'The plan names a file that the spec forbids.',
      }),
    ]);
    const ui = scriptedUI({ selects: [DRIFT_ABORT] });

    // Capture journal.md as it stood the moment the user was prompted.
    let journalAtPrompt: string | null = null;
    const baseSelect = ui.select.bind(ui);
    ui.select = async (label, opts) => {
      journalAtPrompt = await journal().catch(() => '');
      return baseSelect(label, opts);
    };

    const result = await implement(options(ui));

    expect(result).toEqual({
      outcome: 'drift',
      taskId: 'T1',
      reportedBy: 'implementer',
      decision: 'abort',
      details: 'The plan names a file that the spec forbids.',
    });

    // The drift was journaled before the prompt appeared.
    expect(journalAtPrompt).toContain('T1: DRIFT reported by the implementer');
    expect(journalAtPrompt).toContain('The plan names a file that the spec forbids.');

    // The prompt showed the drift report and the three decisions.
    expect(ui.selected).toHaveLength(1);
    expect(ui.selected[0].label).toContain('DRIFT');
    expect(ui.selected[0].label).toContain('The plan names a file that the spec forbids.');
    expect(ui.selected[0].options).toEqual([DRIFT_CONTINUE, DRIFT_AMEND, DRIFT_ABORT]);

    // The loop stopped before the critic: one chat request, nothing ticked.
    expect(mock.chatRequests).toHaveLength(1);
    expect(await repo.readFile(SPEC_REL_PATH)).toContain('1. [ ] T1:');
    expect(await journal()).toContain('T1: user decision on the drift: abort');
  });

  test('critic DRIFT halts the loop, journals, and amend stops for spec/plan changes (AC12)', async () => {
    mock.script([
      implementerReport('T1'),
      criticVerdict('DRIFT', 'AC1 contradicts the plan for T1.'),
    ]);
    const ui = scriptedUI({ selects: [DRIFT_AMEND] });

    const result = await implement(options(ui));

    expect(result).toEqual({
      outcome: 'drift',
      taskId: 'T1',
      reportedBy: 'critic',
      decision: 'amend',
      details: 'AC1 contradicts the plan for T1.',
    });

    expect(mock.chatRequests).toHaveLength(2);
    const entries = await journal();
    expect(entries).toContain('T1: DRIFT reported by the critic');
    expect(entries).toContain('AC1 contradicts the plan for T1.');
    expect(entries).toContain('T1: user decision on the drift: amend');
    expect(await repo.readFile(SPEC_REL_PATH)).toContain('1. [ ] T1:');
  });

  test('implementer DRIFT plus continue re-dispatches the implementer with the user note', async () => {
    mock.script([
      implementerReport('T1', { status: 'DRIFT', details: 'Plan ambiguity on T1.' }),
      implementerReport('T1'),
      criticVerdict('PASS', 'T1 verified.'),
      implementerReport('T2'),
      criticVerdict('PASS', 'T2 verified.'),
    ]);
    const ui = scriptedUI({ selects: [DRIFT_CONTINUE] });

    const result = await implement(options(ui));

    expect(result).toEqual({ outcome: 'complete' });
    expect(mock.chatRequests).toHaveLength(5);

    // The re-dispatch told the implementer the user chose to continue.
    const redispatch = dispatchContext(1);
    expect(redispatch).toContain('Task ID: T1');
    expect(redispatch).toContain('Plan ambiguity on T1.');
    expect(redispatch).toContain('decided to continue');

    const entries = await journal();
    expect(entries).toContain('T1: DRIFT reported by the implementer');
    expect(entries).toContain('T1: user decision on the drift: continue');
    expect(await repo.readFile(SPEC_REL_PATH)).toContain('1. [x] T1:');
  });

  test('critic DRIFT plus continue re-dispatches the critic, not the implementer', async () => {
    await repo.writeFile(
      SPEC_REL_PATH,
      demoSpec({ section6: [TASK_LINES[0]] }),
    );
    mock.script([
      implementerReport('T1'),
      criticVerdict('DRIFT', 'Spec ambiguity on T1.'),
      criticVerdict('PASS', 'T1 verified per the spec as written.'),
    ]);
    const ui = scriptedUI({ selects: [DRIFT_CONTINUE] });

    const result = await implement(options(ui));

    expect(result).toEqual({ outcome: 'complete' });

    // One implementer dispatch, two critic dispatches: the existing work is
    // re-judged, not re-implemented.
    expect(mock.chatRequests).toHaveLength(3);
    const recheck = dispatchContext(2);
    expect(recheck).toContain('Spec ambiguity on T1.');
    expect(recheck).toContain('decided to continue');
    expect(recheck).toContain('src/demo-T1.ts: created');

    expect(await repo.readFile(SPEC_REL_PATH)).toContain('1. [x] T1:');
  });

  test('a spec with no unchecked tasks completes without any dispatch', async () => {
    await repo.writeFile(
      SPEC_REL_PATH,
      demoSpec({
        status: 'IN PROGRESS',
        section6: [
          '1. [x] T1: Set up the demo scaffold - verifies: AC1 - depends_on: none',
          '2. [x] T2: Make the demo work - verifies: AC1 - depends_on: T1',
        ],
      }),
    );

    const result = await implement(options(scriptedUI()));

    expect(result).toEqual({ outcome: 'complete' });
    expect(mock.chatRequests).toHaveLength(0);
  });
});
