import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { startMockOllama, MockOllamaServer, MockToolCall } from './helpers/mock-ollama';
import { makeTempRepo, TempRepo } from './helpers/temp-repo';
import {
  specify,
  validateDraftSpec,
  SpecifyError,
  SpecifyOptions,
  GATE1_APPROVE,
  GATE1_REQUEST_CHANGES,
  GATE1_ABORT,
  VALIDATION_RETRY_CAP,
} from '../src/phases/specify';
import type { ChatMessage } from '../src/ollama';
import type { ChoiceResult, UI } from '../src/ui';

/** UI with scripted answers that records every prompt it was shown. */
interface ScriptedUI extends UI {
  asked: string[];
  selected: Array<{ label: string; options: string[] }>;
  chosen: Array<{ label: string; options: string[] }>;
  readAnswered: string[];
}

function scriptedUI(
  script: {
    asks?: string[];
    selects?: string[];
    chooses?: ChoiceResult[];
    readAnswers?: string[];
  } = {},
): ScriptedUI {
  const asks = [...(script.asks ?? [])];
  const selects = [...(script.selects ?? [])];
  const chooses = [...(script.chooses ?? [])];
  const readAnswers = [...(script.readAnswers ?? [])];
  const ui: ScriptedUI = {
    asked: [],
    selected: [],
    chosen: [],
    readAnswered: [],
    async ask(question) {
      ui.asked.push(question);
      const answer = asks.shift();
      if (answer === undefined) throw new Error('scriptedUI: no scripted ask answer left');
      return answer;
    },
    async confirm() {
      throw new Error('scriptedUI: confirm is not scripted (the supervisor never confirms)');
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
    async readAnswer(message) {
      ui.readAnswered.push(message);
      const answer = readAnswers.shift();
      if (answer === undefined) throw new Error('scriptedUI: no scripted readAnswer answer left');
      return answer;
    },
  };
  return ui;
}

function call(name: string, args: Record<string, unknown>): MockToolCall {
  return { function: { name, arguments: args } };
}

const SPEC_REL_PATH = 'specs/001-demo/spec.md';

/** A spec.md following the vendored template structure. Overrides poke holes
 * in it for the validation tests. */
function draftSpec(
  overrides: { status?: string; mission?: string; section2?: string; section6Body?: string } = {},
): string {
  return [
    '# Feature Spec: Demo Feature',
    '',
    `> Status: ${overrides.status ?? 'DRAFT'}`,
    '> Spec folder: specs/001-demo/',
    '',
    '## 1. Mission / Why',
    '',
    overrides.mission ?? 'Build a demo feature so the SPECIFY phase can be tested.',
    '',
    '## 2. Outcome',
    '',
    overrides.section2 ?? 'A user can run the demo and see it work.',
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
    '- A second exclusion',
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
    '<!-- Filled in by the planner, approved by the user at Gate 2. -->',
    ...(overrides.section6Body !== undefined ? ['', overrides.section6Body] : []),
    '',
    '## 7. Open Questions',
    '',
    '- None.',
    '',
  ].join('\n');
}

/** Script entries for one whole dispatch that writes `content` and reports. */
function writeAndReport(content: string, match?: string) {
  return [
    { match, tool_calls: [call('write_file', { path: SPEC_REL_PATH, content })] },
    { tool_calls: [call('report', { spec_path: SPEC_REL_PATH })] },
  ];
}

describe('validateDraftSpec', () => {
  test('a template-shaped DRAFT spec with sections 1-5 filled is valid', () => {
    expect(validateDraftSpec(draftSpec())).toEqual([]);
  });

  test('a non-DRAFT status is rejected', () => {
    const errors = validateDraftSpec(draftSpec({ status: 'SPECIFIED' }));
    expect(errors).toEqual([expect.stringContaining('DRAFT')]);
  });

  test('an empty section among 1-5 is rejected', () => {
    const errors = validateDraftSpec(draftSpec({ section2: '' }));
    expect(errors).toEqual([expect.stringContaining('section 2 is empty')]);
  });

  test('content in section 6 is rejected; the template comment is tolerated', () => {
    const errors = validateDraftSpec(
      draftSpec({ section6Body: '1. [ ] T1: sneak task - verifies: AC1 - depends_on: none' }),
    );
    expect(errors).toEqual([expect.stringContaining('section 6 must be empty')]);
  });

  test('missing section headings are rejected', () => {
    // Without the section 7 heading, section 7's content also bleeds into
    // section 6, so both errors are reported.
    const noSection7 = draftSpec().replace('## 7. Open Questions', '');
    expect(validateDraftSpec(noSection7)).toEqual(
      expect.arrayContaining([expect.stringContaining('missing "## 7." section heading')]),
    );
  });
});

describe('specify phase and Gate 1', () => {
  let mock: MockOllamaServer;
  let repo: TempRepo;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(() => mock.close());

  beforeEach(async () => {
    mock.reset();
    repo = await makeTempRepo();
  });

  afterEach(() => repo.cleanup());

  function options(ui: UI, overrides: Partial<SpecifyOptions> = {}): SpecifyOptions {
    return {
      repoRoot: repo.root,
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

  test('scripted interview produces a valid DRAFT spec and approval flips it to SPECIFIED (AC1)', async () => {
    mock.script([
      { content: 'What is the mission of this feature?' },
      ...writeAndReport(draftSpec()),
    ]);
    const ui = scriptedUI({
      asks: ['Build a demo feature.'],
      readAnswers: ['Testing the SPECIFY phase.'],
      chooses: [{ option: GATE1_APPROVE }],
    });

    const result = await specify(options(ui));

    expect(result).toEqual({
      outcome: 'approved',
      specPath: path.join(repo.root, SPEC_REL_PATH),
    });

    // The saved spec kept its interview content; only the status changed.
    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('> Status: SPECIFIED');
    expect(saved).toContain('## 1. Mission / Why');
    expect(saved).toContain('Build a demo feature so the SPECIFY phase can be tested.');
    expect(validateDraftSpec(saved)).toEqual([expect.stringContaining('DRAFT')]);

    // The interview ran through the injected UI: the opening request stays
    // on ask; the model's question goes verbatim to readAnswer as printed
    // output, never as a prompt string.
    expect(ui.asked).toEqual([expect.stringContaining('Describe the feature')]);
    expect(ui.readAnswered).toEqual(['What is the mission of this feature?']);

    // The phase stopped at Gate 1 and offered the three choices.
    expect(ui.chosen).toHaveLength(1);
    expect(ui.chosen[0].label).toContain('Gate 1');
    expect(ui.chosen[0].label).toContain(SPEC_REL_PATH);
    expect(ui.chosen[0].options).toEqual([GATE1_APPROVE, GATE1_REQUEST_CHANGES, GATE1_ABORT]);

    // The dispatch context carried the opening request and the vendored
    // template content (the template is context, not a sandbox file).
    const context = chatMessages(0)[1];
    expect(context.role).toBe('user');
    expect(context.content).toContain('Build a demo feature.');
    expect(context.content).toContain('<template>');
    expect(context.content).toContain('## 6. Task Breakdown');
  });

  test('Gate 1 abort leaves the spec DRAFT, section 6 empty, and no plan.md (AC5 part)', async () => {
    mock.script(writeAndReport(draftSpec()));
    const ui = scriptedUI({ asks: ['Build a demo feature.'], chooses: [{ option: GATE1_ABORT }] });

    const result = await specify(options(ui));

    expect(result).toEqual({ outcome: 'aborted' });

    // No status flip, section 6 still empty: the draft is exactly as saved.
    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('> Status: DRAFT');
    expect(validateDraftSpec(saved)).toEqual([]);

    // No later-phase artifacts exist anywhere in the spec folder.
    await expect(fs.access(path.join(repo.root, 'specs/001-demo/plan.md'))).rejects.toThrow();
    const specDir = await fs.readdir(path.join(repo.root, 'specs/001-demo'));
    expect(specDir).toEqual(['spec.md']);
  });

  test('Gate 1 request-changes re-enters the interview with the feedback appended', async () => {
    const revised = draftSpec({ mission: 'Build a demo feature, now with logging.' });
    mock.script([
      ...writeAndReport(draftSpec()),
      ...writeAndReport(revised, 'Gate 1 feedback'),
    ]);
    const ui = scriptedUI({
      asks: ['Build a demo feature.', 'Please mention logging in the mission.'],
      chooses: [{ option: GATE1_REQUEST_CHANGES }, { option: GATE1_APPROVE }],
    });

    const result = await specify(options(ui));

    expect(result.outcome).toBe('approved');
    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('now with logging');
    expect(saved).toContain('> Status: SPECIFIED');

    // The second dispatch's first user message carried the user's feedback.
    expect(mock.chatRequests).toHaveLength(4);
    const redispatchContext = chatMessages(2)[1];
    expect(redispatchContext.role).toBe('user');
    expect(redispatchContext.content).toContain('Gate 1 feedback');
    expect(redispatchContext.content).toContain('Please mention logging in the mission.');

    // Gate 1 was consulted twice: reject, then approve.
    expect(ui.chosen).toHaveLength(2);
  });

  test('an invalid draft re-prompts the supervisor with the validation errors', async () => {
    const invalid = draftSpec({
      section6Body: '1. [ ] T1: sneak task - verifies: AC1 - depends_on: none',
    });
    mock.script([
      ...writeAndReport(invalid),
      ...writeAndReport(draftSpec(), 'failed validation'),
    ]);
    const ui = scriptedUI({ asks: ['Build a demo feature.'], chooses: [{ option: GATE1_APPROVE }] });

    const result = await specify(options(ui));

    expect(result.outcome).toBe('approved');
    expect(mock.chatRequests).toHaveLength(4);
    const redispatchContext = chatMessages(2)[1];
    expect(redispatchContext.content).toContain('failed validation');
    expect(redispatchContext.content).toContain('section 6 must be empty');

    // Gate 1 was only reached once, with the valid draft.
    expect(ui.chosen).toHaveLength(1);
  });

  test('a report naming a file that was never written re-prompts the supervisor', async () => {
    mock.script([
      { tool_calls: [call('report', { spec_path: SPEC_REL_PATH })] },
      ...writeAndReport(draftSpec(), 'does not exist'),
    ]);
    const ui = scriptedUI({ asks: ['Build a demo feature.'], chooses: [{ option: GATE1_APPROVE }] });

    const result = await specify(options(ui));

    expect(result.outcome).toBe('approved');
    const redispatchContext = chatMessages(1)[1];
    expect(redispatchContext.content).toContain('does not exist');
  });

  test('persistent validation failures fail the phase past the re-prompt cap', async () => {
    const invalid = draftSpec({ section2: '' });
    mock.script(
      Array.from({ length: VALIDATION_RETRY_CAP + 1 }, () => writeAndReport(invalid)).flat(),
    );
    const ui = scriptedUI({ asks: ['Build a demo feature.'] });

    const error = await specify(options(ui)).catch((e) => e);

    expect(error).toBeInstanceOf(SpecifyError);
    expect(error.message).toContain('failed validation');
    expect(error.message).toContain('section 2');
    // Every dispatch was consumed; Gate 1 was never reached.
    expect(mock.pendingReplies).toBe(0);
    expect(ui.chosen).toHaveLength(0);
  });

  test('Gate 1 approve WITH a note proceeds to SPECIFIED exactly as without a note, and journals the note (AC6)', async () => {
    mock.script(writeAndReport(draftSpec()));
    const ui = scriptedUI({
      asks: ['Build a demo feature.'],
      chooses: [{ option: GATE1_APPROVE, note: 'looks good, ship it' }],
    });

    const result = await specify(options(ui));

    // The approve branch is unchanged: same approved outcome, status flip.
    expect(result).toEqual({
      outcome: 'approved',
      specPath: path.join(repo.root, SPEC_REL_PATH),
    });
    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('> Status: SPECIFIED');

    // The attached note was journaled to journal.md in the spec folder.
    const journal = await repo.readFile('specs/001-demo/journal.md');
    expect(journal).toContain(`Gate 1 (${SPEC_REL_PATH}): user chose "${GATE1_APPROVE}"`);
    expect(journal).toContain('looks good, ship it');
  });

  test('Gate 1 abort WITH a note still aborts, and journals the note (AC6)', async () => {
    mock.script(writeAndReport(draftSpec()));
    const ui = scriptedUI({
      asks: ['Build a demo feature.'],
      chooses: [{ option: GATE1_ABORT, note: 'changed my mind' }],
    });

    const result = await specify(options(ui));

    // The abort branch is unchanged: aborted outcome, no status flip.
    expect(result).toEqual({ outcome: 'aborted' });
    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('> Status: DRAFT');

    // The note was journaled even on the abort branch (resolved Q3).
    const journal = await repo.readFile('specs/001-demo/journal.md');
    expect(journal).toContain(`Gate 1 (${SPEC_REL_PATH}): user chose "${GATE1_ABORT}"`);
    expect(journal).toContain('changed my mind');
  });

  test('Gate 1 request-changes WITH a note uses the note as feedback and SKIPS the follow-up (AC8)', async () => {
    const revised = draftSpec({ mission: 'Build a demo feature, now with logging.' });
    mock.script([
      ...writeAndReport(draftSpec()),
      ...writeAndReport(revised, 'Gate 1 feedback'),
    ]);
    const ui = scriptedUI({
      // T8: a note attached to request-changes IS the feedback, so the
      // FEEDBACK_QUESTION follow-up is not asked. The opening request is the
      // only ask scripted; no follow-up answer is provided.
      asks: ['Build a demo feature.'],
      chooses: [{ option: GATE1_REQUEST_CHANGES, note: 'needs logging' }, { option: GATE1_APPROVE }],
    });

    const result = await specify(options(ui));

    // The branch behaviour is unchanged (it re-entered the interview), but the
    // follow-up question was NOT asked: only the opening request reached ask.
    expect(result.outcome).toBe('approved');
    expect(ui.asked).not.toContain('What should change in the spec?');
    expect(ui.asked).toEqual([expect.stringContaining('Describe the feature')]);

    // The note drove the re-dispatch context as the feedback.
    const redispatchContext = chatMessages(2)[1];
    expect(redispatchContext.content).toContain('Gate 1 feedback');
    expect(redispatchContext.content).toContain('needs logging');

    const saved = await repo.readFile(SPEC_REL_PATH);
    expect(saved).toContain('now with logging');

    // The note from the first (request-changes) choice was journaled.
    const journal = await repo.readFile('specs/001-demo/journal.md');
    expect(journal).toContain(`Gate 1 (${SPEC_REL_PATH}): user chose "${GATE1_REQUEST_CHANGES}"`);
    expect(journal).toContain('needs logging');
  });

  test('Gate 1 request-changes WITHOUT a note still asks the follow-up question (AC8)', async () => {
    const revised = draftSpec({ mission: 'Build a demo feature, now with logging.' });
    mock.script([
      ...writeAndReport(draftSpec()),
      ...writeAndReport(revised, 'Gate 1 feedback'),
    ]);
    const ui = scriptedUI({
      asks: ['Build a demo feature.', 'Please mention logging in the mission.'],
      chooses: [{ option: GATE1_REQUEST_CHANGES }, { option: GATE1_APPROVE }],
    });

    const result = await specify(options(ui));

    // With no note, the follow-up question is asked and its answer is the
    // feedback that drives the re-dispatch.
    expect(result.outcome).toBe('approved');
    expect(ui.asked).toContain('What should change in the spec?');
    const redispatchContext = chatMessages(2)[1];
    expect(redispatchContext.content).toContain('Please mention logging in the mission.');
  });
});
