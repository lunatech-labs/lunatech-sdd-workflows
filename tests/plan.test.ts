import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { startMockOllama, MockOllamaServer, MockToolCall } from './helpers/mock-ollama';
import { makeTempRepo, TempRepo } from './helpers/temp-repo';
import {
  plan,
  PlanError,
  PlanOptions,
  GATE2_APPROVE,
  GATE2_REQUEST_CHANGES,
  GATE2_ABORT,
} from '../src/phases/plan';
import type { ChatMessage } from '../src/ollama';
import type { ChoiceResult, UI } from '../src/ui';

/** UI with scripted answers that records every prompt it was shown. */
interface ScriptedUI extends UI {
  asked: string[];
  selected: Array<{ label: string; options: string[] }>;
  chosen: Array<{ label: string; options: string[] }>;
}

function scriptedUI(
  script: { asks?: string[]; selects?: string[]; chooses?: ChoiceResult[] } = {},
): ScriptedUI {
  const asks = [...(script.asks ?? [])];
  const selects = [...(script.selects ?? [])];
  const chooses = [...(script.chooses ?? [])];
  const ui: ScriptedUI = {
    asked: [],
    selected: [],
    chosen: [],
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
    async choose(label, options) {
      ui.chosen.push({ label, options });
      const answer = chooses.shift();
      if (answer === undefined) throw new Error('scriptedUI: no scripted choose answer left');
      return answer;
    },
    async confirmWithNote() {
      throw new Error('scriptedUI: confirmWithNote is not scripted');
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

const TEMPLATE_COMMENT = '<!-- Filled in by the planner, approved by the user at Gate 2. -->';

const TASK_LINES = [
  '1. [ ] T1: Set up the demo scaffold - verifies: AC1 - depends_on: none',
  '2. [ ] T2: Make the demo work - verifies: AC1 - depends_on: T1',
];

/** A spec.md following the vendored template structure, Status SPECIFIED by
 * default (the Gate 1 approved state the PLAN phase starts from). */
function demoSpec(
  overrides: {
    status?: string;
    mission?: string;
    section6?: string[];
    section7?: string[];
  } = {},
): string {
  return [
    '# Feature Spec: Demo Feature',
    '',
    `> Status: ${overrides.status ?? 'SPECIFIED'}`,
    '> Spec folder: specs/001-demo/',
    '',
    '## 1. Mission / Why',
    '',
    overrides.mission ?? 'Build a demo feature so the PLAN phase can be tested.',
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
    ...(overrides.section6 ?? [TEMPLATE_COMMENT]),
    '',
    '## 7. Open Questions',
    '',
    ...(overrides.section7 ?? ['- Existing question.']),
    '',
  ].join('\n');
}

const PLAN_CONTENT = '# Plan: Demo Feature\n\n## Technical approach\n\n- Do the demo.\n';

/** Script entries for one whole planner dispatch: write plan.md, write
 * spec.md, report. Each entry is one /api/chat reply. */
function plannerDispatch(
  options: { planContent?: string | null; specContent?: string; match?: string } = {},
) {
  const entries = [];
  if (options.planContent !== null) {
    entries.push({
      match: options.match,
      tool_calls: [
        call('write_file', { path: PLAN_REL_PATH, content: options.planContent ?? PLAN_CONTENT }),
      ],
    });
  }
  entries.push(
    {
      match: entries.length === 0 ? options.match : undefined,
      tool_calls: [
        call('write_file', {
          path: SPEC_REL_PATH,
          content: options.specContent ?? demoSpec({ section6: TASK_LINES }),
        }),
      ],
    },
    {
      tool_calls: [
        call('report', {
          summary: 'Two-task approach over the demo.',
          task_list: TASK_LINES.join('\n'),
          gate_notes: 'Nothing surprising.',
        }),
      ],
    },
  );
  return entries;
}

describe('plan phase and Gate 2', () => {
  let mock: MockOllamaServer;
  let repo: TempRepo;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(() => mock.close());

  beforeEach(async () => {
    mock.reset();
    repo = await makeTempRepo({ files: { [SPEC_REL_PATH]: demoSpec() } });
  });

  afterEach(() => repo.cleanup());

  function options(ui: UI, overrides: Partial<PlanOptions> = {}): PlanOptions {
    return {
      repoRoot: repo.root,
      specPath: path.join(repo.root, SPEC_REL_PATH),
      baseUrl: mock.baseUrl,
      model: 'mock-model',
      ui,
      onProgress: () => {},
      ...overrides,
    };
  }

  /** Messages of the nth recorded /api/chat request. */
  function chatMessages(index: number): ChatMessage[] {
    return (mock.chatRequests[index] as { messages: ChatMessage[] }).messages;
  }

  test('scripted planner writes plan.md and section 6; approval flips status to PLANNED (AC2)', async () => {
    mock.script(plannerDispatch());
    const ui = scriptedUI({ chooses: [{ option: GATE2_APPROVE }] });

    const result = await plan(options(ui));

    expect(result).toEqual({
      outcome: 'approved',
      planPath: path.join(repo.root, PLAN_REL_PATH),
    });

    // plan.md was written and spec section 6 holds the task breakdown.
    expect(await repo.readFile(PLAN_REL_PATH)).toBe(PLAN_CONTENT);
    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('> Status: PLANNED');
    expect(saved).toContain(TASK_LINES[0]);
    expect(saved).toContain(TASK_LINES[1]);

    // Sections 1 to 5 survived byte-identical apart from the status flip.
    expect(saved).toContain('Build a demo feature so the PLAN phase can be tested.');
    expect(saved).toContain('- [ ] AC1: Given a demo, when it runs, then it works.');

    // The dispatch context carried the spec path and the repo root.
    const context = chatMessages(0)[1];
    expect(context.role).toBe('user');
    expect(context.content).toContain(SPEC_REL_PATH);
    expect(context.content).toContain(repo.root);

    // The phase stopped at Gate 2, presenting the summary and the task list.
    expect(ui.chosen).toHaveLength(1);
    expect(ui.chosen[0].label).toContain('Gate 2');
    expect(ui.chosen[0].label).toContain('Two-task approach over the demo.');
    expect(ui.chosen[0].label).toContain('T1: Set up the demo scaffold');
    expect(ui.chosen[0].label).toContain('T2: Make the demo work');
    expect(ui.chosen[0].options).toEqual([GATE2_APPROVE, GATE2_REQUEST_CHANGES, GATE2_ABORT]);
  });

  test('Gate 2 abort leaves the spec SPECIFIED and no implementation files exist (AC5 part)', async () => {
    mock.script(plannerDispatch());
    const ui = scriptedUI({ chooses: [{ option: GATE2_ABORT }] });

    const result = await plan(options(ui));

    expect(result).toEqual({ outcome: 'aborted' });

    // No status flip past SPECIFIED.
    expect(await repo.readFile(SPEC_REL_PATH)).toContain('> Status: SPECIFIED');

    // Only PLAN-phase artifacts exist: no implementation file changes
    // anywhere in the repo (the specs folder is all there is).
    expect(await fs.readdir(repo.root)).toEqual(['specs']);
    expect((await fs.readdir(path.join(repo.root, 'specs/001-demo'))).sort()).toEqual([
      'plan.md',
      'spec.md',
    ]);
  });

  test('Gate 2 request-changes re-dispatches the planner with the feedback', async () => {
    const revisedPlan = PLAN_CONTENT + '\n## Revised\n\n- Now with logging.\n';
    mock.script([
      ...plannerDispatch(),
      ...plannerDispatch({ planContent: revisedPlan, match: 'Gate 2 feedback' }),
    ]);
    const ui = scriptedUI({
      asks: ['Please cover logging in the plan.'],
      chooses: [{ option: GATE2_REQUEST_CHANGES }, { option: GATE2_APPROVE }],
    });

    const result = await plan(options(ui));

    expect(result.outcome).toBe('approved');
    expect(await repo.readFile(PLAN_REL_PATH)).toBe(revisedPlan);
    expect(await repo.readFile(SPEC_REL_PATH)).toContain('> Status: PLANNED');

    // The re-dispatch's first user message carried the user's feedback.
    expect(mock.chatRequests).toHaveLength(6);
    const redispatchContext = chatMessages(3)[1];
    expect(redispatchContext.role).toBe('user');
    expect(redispatchContext.content).toContain('Gate 2 feedback');
    expect(redispatchContext.content).toContain('Please cover logging in the plan.');

    // Gate 2 was consulted twice: request changes, then approve.
    expect(ui.chosen).toHaveLength(2);
    expect(mock.pendingReplies).toBe(0);
  });

  test('changing sections 1 to 5 restores the snapshot and fails the dispatch', async () => {
    const original = demoSpec();
    mock.script(
      plannerDispatch({
        specContent: demoSpec({ mission: 'A sneakily rewritten mission.', section6: TASK_LINES }),
      }),
    );
    const ui = scriptedUI();

    const error = await plan(options(ui)).catch((e) => e);

    expect(error).toBeInstanceOf(PlanError);
    expect(error.message).toContain('containment');
    expect(error.message).toContain('sections 1 to 5');

    // The snapshot was restored byte-identical; Gate 2 was never reached.
    expect(await repo.readFile(SPEC_REL_PATH)).toBe(original);
    expect(ui.chosen).toHaveLength(0);
  });

  test('rewriting existing section 7 content restores the snapshot and fails the dispatch', async () => {
    const original = demoSpec();
    mock.script(
      plannerDispatch({
        specContent: demoSpec({
          section6: TASK_LINES,
          section7: ['- The existing question, reworded.'],
        }),
      }),
    );
    const ui = scriptedUI();

    const error = await plan(options(ui)).catch((e) => e);

    expect(error).toBeInstanceOf(PlanError);
    expect(error.message).toContain('append-only');
    expect(await repo.readFile(SPEC_REL_PATH)).toBe(original);
    expect(ui.chosen).toHaveLength(0);
  });

  test('appending to section 7 is allowed', async () => {
    mock.script(
      plannerDispatch({
        specContent: demoSpec({
          section6: TASK_LINES,
          section7: ['- Existing question.', '- New question from the planner.'],
        }),
      }),
    );
    const ui = scriptedUI({ chooses: [{ option: GATE2_APPROVE }] });

    const result = await plan(options(ui));

    expect(result.outcome).toBe('approved');
    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('- Existing question.');
    expect(saved).toContain('- New question from the planner.');
  });

  test('a report without plan.md fails the dispatch', async () => {
    mock.script(plannerDispatch({ planContent: null }));
    const ui = scriptedUI();

    const error = await plan(options(ui)).catch((e) => e);

    expect(error).toBeInstanceOf(PlanError);
    expect(error.message).toContain(PLAN_REL_PATH);
    expect(error.message).toContain('does not exist');
    expect(ui.chosen).toHaveLength(0);
  });

  test('task lines missing the verifies/depends_on markers fail the dispatch', async () => {
    mock.script(
      plannerDispatch({
        specContent: demoSpec({ section6: ['1. [ ] T1: a task with no markers'] }),
      }),
    );
    const ui = scriptedUI();

    const error = await plan(options(ui)).catch((e) => e);

    expect(error).toBeInstanceOf(PlanError);
    expect(error.message).toContain('verifies');
    expect(ui.chosen).toHaveLength(0);
  });

  test('an empty section 6 fails the dispatch', async () => {
    mock.script(plannerDispatch({ specContent: demoSpec({ section6: [TEMPLATE_COMMENT] }) }));
    const ui = scriptedUI();

    const error = await plan(options(ui)).catch((e) => e);

    expect(error).toBeInstanceOf(PlanError);
    expect(error.message).toContain('no tasks');
    expect(ui.chosen).toHaveLength(0);
  });

  test('Gate 2 approve WITH a note proceeds to PLANNED exactly as without a note, and journals the note (AC7)', async () => {
    mock.script(plannerDispatch());
    const ui = scriptedUI({
      chooses: [{ option: GATE2_APPROVE, note: 'looks good, ship it' }],
    });

    const result = await plan(options(ui));

    // The approve branch is unchanged: same approved outcome, status flip.
    expect(result).toEqual({
      outcome: 'approved',
      planPath: path.join(repo.root, PLAN_REL_PATH),
    });
    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('> Status: PLANNED');

    // The attached note was journaled to journal.md in the spec folder.
    const journal = await repo.readFile('specs/001-demo/journal.md');
    expect(journal).toContain(`Gate 2 (${PLAN_REL_PATH}): user chose "${GATE2_APPROVE}"`);
    expect(journal).toContain('looks good, ship it');
  });

  test('Gate 2 abort WITH a note still aborts, and journals the note (AC7)', async () => {
    mock.script(plannerDispatch());
    const ui = scriptedUI({
      chooses: [{ option: GATE2_ABORT, note: 'changed my mind' }],
    });

    const result = await plan(options(ui));

    // The abort branch is unchanged: aborted outcome, no status flip.
    expect(result).toEqual({ outcome: 'aborted' });
    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('> Status: SPECIFIED');

    // The note was journaled even on the abort branch (resolved Q3).
    const journal = await repo.readFile('specs/001-demo/journal.md');
    expect(journal).toContain(`Gate 2 (${PLAN_REL_PATH}): user chose "${GATE2_ABORT}"`);
    expect(journal).toContain('changed my mind');
  });

  test('Gate 2 request-changes WITH a note uses the note as feedback and SKIPS the follow-up (AC8)', async () => {
    const revisedPlan = PLAN_CONTENT + '\n## Revised\n\n- Now with logging.\n';
    mock.script([
      ...plannerDispatch(),
      ...plannerDispatch({ planContent: revisedPlan, match: 'Gate 2 feedback' }),
    ]);
    const ui = scriptedUI({
      // T8: a note attached to request-changes IS the feedback, so the
      // FEEDBACK_QUESTION follow-up is not asked. No ask answers are scripted.
      chooses: [{ option: GATE2_REQUEST_CHANGES, note: 'needs logging' }, { option: GATE2_APPROVE }],
    });

    const result = await plan(options(ui));

    // The branch behaviour is unchanged (it re-dispatched the planner), but the
    // follow-up question was NOT asked.
    expect(result.outcome).toBe('approved');
    expect(ui.asked).not.toContain('What should change in the plan?');
    expect(ui.asked).toEqual([]);
    expect(await repo.readFile(PLAN_REL_PATH)).toBe(revisedPlan);

    // The note drove the re-dispatch context as the feedback.
    const redispatchContext = chatMessages(3)[1];
    expect(redispatchContext.content).toContain('Gate 2 feedback');
    expect(redispatchContext.content).toContain('needs logging');

    // The note from the first (request-changes) choice was journaled.
    const journal = await repo.readFile('specs/001-demo/journal.md');
    expect(journal).toContain(`Gate 2 (${PLAN_REL_PATH}): user chose "${GATE2_REQUEST_CHANGES}"`);
    expect(journal).toContain('needs logging');
  });

  test('Gate 2 request-changes WITHOUT a note still asks the follow-up question (AC8)', async () => {
    const revisedPlan = PLAN_CONTENT + '\n## Revised\n\n- Now with logging.\n';
    mock.script([
      ...plannerDispatch(),
      ...plannerDispatch({ planContent: revisedPlan, match: 'Gate 2 feedback' }),
    ]);
    const ui = scriptedUI({
      asks: ['Please cover logging in the plan.'],
      chooses: [{ option: GATE2_REQUEST_CHANGES }, { option: GATE2_APPROVE }],
    });

    const result = await plan(options(ui));

    // With no note, the follow-up question is asked and its answer drives the
    // re-dispatch.
    expect(result.outcome).toBe('approved');
    expect(ui.asked).toContain('What should change in the plan?');
    const redispatchContext = chatMessages(3)[1];
    expect(redispatchContext.content).toContain('Please cover logging in the plan.');
  });
});
