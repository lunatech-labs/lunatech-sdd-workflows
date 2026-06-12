/**
 * End-to-end test of the full phase machine (AC14, AC5 full): main() from
 * src/index.ts driven against scripted mock-Ollama conversations in a temp
 * repo, covering the complete SPECIFY -> Gate 1 -> PLAN -> Gate 2 ->
 * IMPLEMENT -> PRESENT run, the Gate 1 and Gate 2 rejection branches (no
 * later-phase artifacts), task-level resume, and the unreachable-Ollama
 * clean exit.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { startMockOllama, MockOllamaServer, MockToolCall } from './helpers/mock-ollama';
import { makeTempRepo, TempRepo } from './helpers/temp-repo';
import { main } from '../src/index';
import { GATE1_APPROVE, GATE1_ABORT } from '../src/phases/specify';
import { GATE2_APPROVE, GATE2_ABORT } from '../src/phases/plan';
import type { ChatMessage } from '../src/ollama';
import type { UI } from '../src/ui';

/** UI with scripted answers that records every prompt it was shown. */
interface ScriptedUI extends UI {
  asked: string[];
  confirmed: string[];
  selected: Array<{ label: string; options: string[] }>;
}

function scriptedUI(
  script: { asks?: string[]; confirms?: boolean[]; selects?: string[] } = {},
): ScriptedUI {
  const asks = [...(script.asks ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const selects = [...(script.selects ?? [])];
  const ui: ScriptedUI = {
    asked: [],
    confirmed: [],
    selected: [],
    async ask(question) {
      ui.asked.push(question);
      const answer = asks.shift();
      if (answer === undefined) throw new Error(`scriptedUI: unscripted ask: ${question}`);
      return answer;
    },
    async confirm(question) {
      ui.confirmed.push(question);
      const answer = confirms.shift();
      if (answer === undefined) throw new Error(`scriptedUI: unscripted confirm: ${question}`);
      return answer;
    },
    async select(label, options) {
      ui.selected.push({ label, options });
      const answer = selects.shift();
      if (answer === undefined) throw new Error(`scriptedUI: unscripted select: ${label}`);
      return answer;
    },
    async readAnswer(message) {
      throw new Error(`scriptedUI: unscripted readAnswer: ${message}`);
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

const EMPTY_SECTION6 = ['<!-- Filled in by the planner, approved by the user at Gate 2. -->'];
const TASK_LINES = [
  '1. [ ] T1: Set up the demo scaffold - verifies: AC1 - depends_on: none',
  '2. [ ] T2: Make the demo report success - verifies: AC1, AC2 - depends_on: T1',
];

/**
 * A spec.md following the vendored template structure. Built so that the
 * post-Gate 1 file (status flipped to SPECIFIED, nothing else touched) is
 * byte-identical to specContent('SPECIFIED', EMPTY_SECTION6), which lets the
 * scripted planner pass the sections 1-5 containment check.
 */
function specContent(status: string, section6: string[]): string {
  return [
    '# Feature Spec: Demo Feature',
    '',
    `> Status: ${status}`,
    '> Spec folder: specs/001-demo/',
    '',
    '## 1. Mission / Why',
    '',
    'Build a demo feature so the full phase machine can be tested.',
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
    '- [ ] AC2: Given a demo, when it finishes, then it reports success.',
    '',
    '## 6. Task Breakdown',
    '',
    ...section6,
    '',
    '## 7. Open Questions',
    '',
    '- None.',
    '',
  ].join('\n');
}

const PLAN_CONTENT = '# Plan: Demo Feature\n\n- T1: scaffold the demo.\n- T2: report success.\n';

/** A complete sdd.config.json so resolveConfig asks nothing interactively. */
function configJson(baseUrl: string): string {
  const config = {
    ollamaBaseUrl: baseUrl,
    models: {
      supervisor: 'mock-model',
      planner: 'mock-model',
      implementer: 'mock-model',
      critic: 'mock-model',
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Script for one whole supervisor dispatch: write the draft spec, report. */
function supervisorScript() {
  return [
    {
      match: 'Conduct the SPECIFY interview',
      tool_calls: [
        call('write_file', { path: SPEC_REL_PATH, content: specContent('DRAFT', EMPTY_SECTION6) }),
      ],
    },
    { tool_calls: [call('report', { spec_path: SPEC_REL_PATH })] },
  ];
}

/** Script for one whole planner dispatch: plan.md, spec section 6, report. */
function plannerScript() {
  return [
    {
      match: 'Produce the technical plan',
      tool_calls: [
        call('write_file', { path: PLAN_REL_PATH, content: PLAN_CONTENT }),
        call('write_file', {
          path: SPEC_REL_PATH,
          content: specContent('SPECIFIED', TASK_LINES),
        }),
      ],
    },
    { tool_calls: [call('report', { summary: 'Two tasks: scaffold, then success.' })] },
  ];
}

/** Script for one task: implementer CLEAN report, then critic PASS verdict. */
function taskScript(taskId: string) {
  return [
    {
      match: 'Implement exactly one task',
      tool_calls: [
        call('report', {
          task_id: taskId,
          changes: `src/demo-${taskId}.ts: created`,
          verification: 'npm test: pass',
          status: 'CLEAN',
        }),
      ],
    },
    {
      match: 'Verify one implemented task',
      tool_calls: [
        call('report', { verdict: 'PASS', details: `${taskId} verified against the spec.` }),
      ],
    },
  ];
}

describe('end-to-end phase machine', () => {
  let mock: MockOllamaServer;
  let repo: TempRepo | undefined;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(() => mock.close());

  beforeEach(() => {
    mock.reset();
  });

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  /** Clean committed repo with a complete config: no startup prompts. */
  async function makeRepo(extraFiles: Record<string, string> = {}): Promise<TempRepo> {
    repo = await makeTempRepo({
      git: true,
      commit: true,
      files: { 'sdd.config.json': configJson(mock.baseUrl), ...extraFiles },
    });
    return repo;
  }

  function run(ui: UI, lines: string[]): Promise<number> {
    return main({
      repoRoot: (repo as TempRepo).root,
      ui,
      out: (line) => lines.push(line),
      onProgress: () => {},
    });
  }

  /** All message content of every recorded /api/chat request, joined. */
  function allChatContent(): string {
    return mock.chatRequests
      .map((body) =>
        ((body as { messages: ChatMessage[] }).messages ?? [])
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n'),
      )
      .join('\n');
  }

  test('full run: SPECIFY, Gate 1, PLAN, Gate 2, IMPLEMENT, PRESENT (AC14)', async () => {
    await makeRepo();
    mock.script([
      ...supervisorScript(),
      ...plannerScript(),
      ...taskScript('T1'),
      ...taskScript('T2'),
    ]);
    const ui = scriptedUI({
      asks: ['Build a demo feature.'],
      selects: [GATE1_APPROVE, GATE2_APPROVE],
    });
    const lines: string[] = [];

    const code = await run(ui, lines);

    expect(code).toBe(0);
    expect(mock.pendingReplies).toBe(0);

    // Both gates were offered, in order.
    expect(ui.selected).toHaveLength(2);
    expect(ui.selected[0].label).toContain('Gate 1');
    expect(ui.selected[1].label).toContain('Gate 2');

    // All artifacts exist; tasks ticked; status DONE (set by PRESENT).
    const spec = await repo!.readFile(SPEC_REL_PATH);
    expect(spec).toContain('> Status: DONE');
    expect(spec).toContain('[x] T1:');
    expect(spec).toContain('[x] T2:');
    expect(await repo!.readFile(PLAN_REL_PATH)).toBe(PLAN_CONTENT);
    const journal = await repo!.readFile(JOURNAL_REL_PATH);
    expect(journal).toContain('T1: critic verdict PASS');
    expect(journal).toContain('T2: critic verdict PASS');

    // PRESENT reported each acceptance criterion as verified, with the
    // verifying tasks and their journal verdicts, and no drift.
    const output = lines.join('\n');
    expect(output).toContain('AC1: VERIFIED');
    expect(output).toContain('AC2: VERIFIED');
    expect(output).toContain('T1 [x] (critic PASS)');
    expect(output).toContain('T2 [x] (critic PASS)');
    expect(output).toContain('Drift recorded:');
    expect(output).toContain('none');
    expect(output).toContain('Spec status set to DONE');
  });

  test('Gate 1 rejection: no later-phase artifacts are produced (AC5)', async () => {
    await makeRepo();
    mock.script(supervisorScript());
    const ui = scriptedUI({
      asks: ['Build a demo feature.'],
      selects: [GATE1_ABORT],
    });
    const lines: string[] = [];

    const code = await run(ui, lines);

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Aborted at Gate 1');

    // The spec is still DRAFT with section 6 empty, and the spec folder
    // contains nothing but spec.md: no plan.md, no journal.md.
    const spec = await repo!.readFile(SPEC_REL_PATH);
    expect(spec).toContain('> Status: DRAFT');
    expect(spec).not.toContain('T1:');
    const specDir = await fs.readdir(path.join(repo!.root, 'specs/001-demo'));
    expect(specDir).toEqual(['spec.md']);

    // No PLAN or IMPLEMENT dispatch ever reached the model.
    expect(mock.chatRequests).toHaveLength(2);
    expect(allChatContent()).not.toContain('Produce the technical plan');
    expect(allChatContent()).not.toContain('Implement exactly one task');
  });

  test('Gate 2 rejection: no implementation work happens (AC5)', async () => {
    await makeRepo();
    mock.script([...supervisorScript(), ...plannerScript()]);
    const ui = scriptedUI({
      asks: ['Build a demo feature.'],
      selects: [GATE1_APPROVE, GATE2_ABORT],
    });
    const lines: string[] = [];

    const code = await run(ui, lines);

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Aborted at Gate 2');

    // The status never advanced past SPECIFIED and the implement loop never
    // started: no journal.md, no implementer dispatch, no IN PROGRESS.
    const spec = await repo!.readFile(SPEC_REL_PATH);
    expect(spec).toContain('> Status: SPECIFIED');
    await expect(fs.access(path.join(repo!.root, JOURNAL_REL_PATH))).rejects.toThrow();
    expect(mock.chatRequests).toHaveLength(4);
    expect(allChatContent()).not.toContain('Implement exactly one task');
  });

  test('resume: a PLANNED spec with unchecked tasks re-enters IMPLEMENT (AC10)', async () => {
    await makeRepo({
      [SPEC_REL_PATH]: specContent('PLANNED', TASK_LINES),
      [PLAN_REL_PATH]: PLAN_CONTENT,
    });
    mock.script([...taskScript('T1'), ...taskScript('T2')]);
    const ui = scriptedUI({ confirms: [true] }); // accept the resume offer
    const lines: string[] = [];

    const code = await run(ui, lines);

    expect(code).toBe(0);
    expect(ui.confirmed[0]).toContain('Resume');
    expect(lines.join('\n')).toContain('Resuming specs/001-demo/spec.md');

    // No SPECIFY or PLAN dispatch: straight to the two task dispatches.
    expect(mock.chatRequests).toHaveLength(4);
    expect(allChatContent()).not.toContain('Conduct the SPECIFY interview');
    expect(allChatContent()).not.toContain('Produce the technical plan');

    const spec = await repo!.readFile(SPEC_REL_PATH);
    expect(spec).toContain('> Status: DONE');
    expect(spec).toContain('[x] T1:');
    expect(spec).toContain('[x] T2:');
  });

  test('unreachable Ollama: clean exit with an actionable error, before anything runs (AC9)', async () => {
    // A base URL that refuses connections: an ephemeral port we just closed.
    const dead = await startMockOllama();
    await dead.close();
    repo = await makeTempRepo({
      git: true,
      commit: true,
      files: { 'sdd.config.json': configJson(dead.baseUrl) },
    });
    const ui = scriptedUI(); // any prompt would throw: nothing may run
    const lines: string[] = [];

    const code = await run(ui, lines);

    expect(code).toBe(1);
    const output = lines.join('\n');
    expect(output).toContain('Error:');
    expect(output).toContain('Ollama');
    // No interview, no gates, no agent dispatches.
    expect(ui.asked).toHaveLength(0);
    expect(ui.selected).toHaveLength(0);
    expect(mock.chatRequests).toHaveLength(0);
  });
});
