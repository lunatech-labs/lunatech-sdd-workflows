import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { startMockOllama, MockOllamaServer, MockToolCall } from './helpers/mock-ollama';
import { makeTempRepo, TempRepo } from './helpers/temp-repo';
import { createToolRegistry, AgentRole, REPORT_TOOL_NAME } from '../src/tools/registry';
import { runAgent, AgentLoopError, MALFORMED_CALL_CAP, RunAgentOptions } from '../src/agent-loop';
import type { ChatMessage } from '../src/ollama';
import type { UI } from '../src/ui';

/** UI with scripted answers that records every prompt it was shown. */
interface ScriptedUI extends UI {
  asked: string[];
  confirmed: string[];
}

function scriptedUI(script: { asks?: string[]; confirms?: boolean[] } = {}): ScriptedUI {
  const asks = [...(script.asks ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const ui: ScriptedUI = {
    asked: [],
    confirmed: [],
    async ask(question) {
      ui.asked.push(question);
      const answer = asks.shift();
      if (answer === undefined) throw new Error('scriptedUI: no scripted ask answer left');
      return answer;
    },
    async confirm(question) {
      ui.confirmed.push(question);
      const answer = confirms.shift();
      if (answer === undefined) throw new Error('scriptedUI: no scripted confirm answer left');
      return answer;
    },
    async select() {
      throw new Error('scriptedUI: select is not scripted');
    },
  };
  return ui;
}

function call(name: string, args: Record<string, unknown> | string): MockToolCall {
  return { function: { name, arguments: args } };
}

const CLEAN_REPORT = {
  task_id: 'T1',
  changes: 'src/a.ts: added a',
  verification: 'npm test: pass',
  status: 'CLEAN',
};

/** Messages of the nth recorded /api/chat request. */
function chatMessages(mock: MockOllamaServer, index: number): ChatMessage[] {
  return (mock.chatRequests[index] as { messages: ChatMessage[] }).messages;
}

describe('tool registry', () => {
  const ui = scriptedUI();
  const names = (role: AgentRole): string[] =>
    createToolRegistry({ repoRoot: '/tmp', role, ui }).definitions.map(d => d.function.name);

  test('planner and implementer get all six tools', () => {
    for (const role of ['planner', 'implementer'] as const) {
      expect(names(role)).toEqual([
        'read_file',
        'write_file',
        'list_files',
        'search_files',
        'run_command',
        'report',
      ]);
    }
  });

  test('critic gets no write_file', () => {
    expect(names('critic')).not.toContain('write_file');
    expect(names('critic')).toContain('run_command');
    expect(names('critic')).toContain('report');
  });

  test('supervisor gets no run_command', () => {
    expect(names('supervisor')).not.toContain('run_command');
    expect(names('supervisor')).toContain('write_file');
    expect(names('supervisor')).toContain('report');
  });

  test('report schemas match the vendored prompts per role', () => {
    const reportSchema = (role: AgentRole) => {
      const registry = createToolRegistry({ repoRoot: '/tmp', role, ui });
      const definition = registry.definitions.find(d => d.function.name === REPORT_TOOL_NAME);
      return definition?.function.parameters as {
        properties: Record<string, { enum?: string[] }>;
        required: string[];
      };
    };
    expect(reportSchema('supervisor').required).toContain('spec_path');
    expect(reportSchema('planner').required).toContain('summary');
    expect(reportSchema('implementer').required).toEqual(
      expect.arrayContaining(['task_id', 'changes', 'verification', 'status']),
    );
    expect(reportSchema('implementer').properties.status.enum).toEqual(['CLEAN', 'DRIFT']);
    expect(reportSchema('critic').required).toEqual(
      expect.arrayContaining(['verdict', 'details']),
    );
    expect(reportSchema('critic').properties.verdict.enum).toEqual(['PASS', 'FAIL', 'DRIFT']);
  });

  test('validateReport rejects missing fields and bad enum values', () => {
    const supervisor = createToolRegistry({ repoRoot: '/tmp', role: 'supervisor', ui });
    expect(supervisor.validateReport({})).toEqual({
      ok: false,
      error: expect.stringContaining('spec_path'),
    });
    expect(supervisor.validateReport({ spec_path: 'specs/001-x/spec.md' })).toEqual({ ok: true });

    const critic = createToolRegistry({ repoRoot: '/tmp', role: 'critic', ui });
    const verdictResult = critic.validateReport({ verdict: 'MAYBE', details: 'hmm' });
    expect(verdictResult.ok).toBe(false);
    if (!verdictResult.ok) {
      expect(verdictResult.error).toContain('PASS, FAIL, DRIFT');
    }
    expect(critic.validateReport({ verdict: 'PASS', details: 'verified' })).toEqual({ ok: true });
  });

  test('unknown tools and invalid argument shapes are malformed tool errors', async () => {
    const registry = createToolRegistry({ repoRoot: '/tmp', role: 'critic', ui });

    const unknown = await registry.execute('write_file', { path: 'a', content: 'b' });
    expect(unknown.ok).toBe(false);
    expect(unknown.malformed).toBe(true);
    if (!unknown.ok) expect(unknown.error).toContain('unknown tool "write_file"');

    const badArgs = await registry.execute('read_file', {});
    expect(badArgs.ok).toBe(false);
    expect(badArgs.malformed).toBe(true);
    if (!badArgs.ok) expect(badArgs.error).toContain('"path"');

    const badType = await registry.execute('read_file', { path: 42 });
    expect(badType.ok).toBe(false);
    expect(badType.malformed).toBe(true);
  });

  test('ordinary tool failures are not flagged malformed', async () => {
    const repo = await makeTempRepo();
    try {
      const registry = createToolRegistry({ repoRoot: repo.root, role: 'implementer', ui });
      const missing = await registry.execute('read_file', { path: 'no-such-file.txt' });
      expect(missing.ok).toBe(false);
      expect(missing.malformed).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });
});

describe('agent loop', () => {
  let mock: MockOllamaServer;
  let repo: TempRepo;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(() => mock.close());

  beforeEach(async () => {
    mock.reset();
    repo = await makeTempRepo({ files: { 'notes.txt': 'hello notes' } });
  });

  afterEach(() => repo.cleanup());

  function baseOptions(overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
    return {
      role: 'implementer',
      task: 'T1',
      systemPrompt: 'You are the implementer.',
      context: 'Implement task T1.',
      tools: createToolRegistry({ repoRoot: repo.root, role: 'implementer', ui: scriptedUI() }),
      mode: 'worker',
      maxIterations: 10,
      baseUrl: mock.baseUrl,
      model: 'mock-model',
      onProgress: () => {},
      ...overrides,
    };
  }

  test('happy path: tool call then report returns the report arguments', async () => {
    mock.script([
      { tool_calls: [call('read_file', { path: 'notes.txt' })] },
      { tool_calls: [call(REPORT_TOOL_NAME, CLEAN_REPORT)] },
    ]);
    const progress: string[] = [];

    const report = await runAgent(baseOptions({ onProgress: line => progress.push(line) }));

    expect(report).toEqual(CLEAN_REPORT);
    expect(mock.chatRequests).toHaveLength(2);

    // The second request carries the read_file result back as a tool message.
    const second = chatMessages(mock, 1);
    const toolMessage = second[second.length - 1];
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.tool_name).toBe('read_file');
    expect(toolMessage.content).toBe('hello notes');
    // The assistant turn is replayed with its tool_calls.
    expect(second[second.length - 2].tool_calls).toEqual([
      { function: { name: 'read_file', arguments: { path: 'notes.txt' } } },
    ]);
    // One "model thinking" progress line per chat call.
    expect(progress).toHaveLength(2);
    expect(progress[0]).toContain('mock-model');
  });

  test('tool definitions for the role are sent with every chat call', async () => {
    mock.script([{ tool_calls: [call(REPORT_TOOL_NAME, CLEAN_REPORT)] }]);
    await runAgent(baseOptions());
    const sent = (mock.chatRequests[0] as { tools: Array<{ function: { name: string } }> }).tools;
    expect(sent.map(t => t.function.name)).toContain('run_command');
    expect(sent.map(t => t.function.name)).toContain(REPORT_TOOL_NAME);
  });

  test('malformed calls are retried as tool errors, then the dispatch fails past the cap', async () => {
    // Cap-many malformed calls are tolerated; one more fails the dispatch.
    const malformedReply = { tool_calls: [call('read_file', '{not valid json')] };
    mock.script(Array.from({ length: MALFORMED_CALL_CAP + 1 }, () => ({ ...malformedReply })));

    const error = await runAgent(baseOptions({ task: 'T5' })).catch(e => e);

    expect(error).toBeInstanceOf(AgentLoopError);
    expect(error.message).toContain('implementer');
    expect(error.message).toContain('T5');
    expect(error.message).toContain('malformed');
    expect(mock.chatRequests).toHaveLength(MALFORMED_CALL_CAP + 1);
    // Each tolerated malformed call went back to the model as a tool error.
    const second = chatMessages(mock, 1);
    const toolError = second[second.length - 1];
    expect(toolError.role).toBe('tool');
    expect(toolError.content).toContain('tool error:');
    expect(toolError.content).toContain('not valid JSON');
  });

  test('unknown tool names count toward the malformed cap but the loop continues', async () => {
    mock.script([
      { tool_calls: [call('make_coffee', {})] },
      { tool_calls: [call(REPORT_TOOL_NAME, CLEAN_REPORT)] },
    ]);

    const report = await runAgent(baseOptions());

    expect(report).toEqual(CLEAN_REPORT);
    const second = chatMessages(mock, 1);
    expect(second[second.length - 1].content).toContain('unknown tool "make_coffee"');
  });

  test('exceeding maxIterations fails with the role and task in the message', async () => {
    mock.script([
      { tool_calls: [call('list_files', {})] },
      { tool_calls: [call('list_files', {})] },
    ]);

    const error = await runAgent(baseOptions({ task: 'T9', maxIterations: 2 })).catch(e => e);

    expect(error).toBeInstanceOf(AgentLoopError);
    expect(error.message).toContain('implementer');
    expect(error.message).toContain('T9');
    expect(error.message).toContain('2-iteration cap');
    expect(mock.chatRequests).toHaveLength(2);
  });

  test('run_command denial goes back as a tool error and the loop continues (AC6)', async () => {
    const marker = path.join(repo.root, 'side-effect.txt');
    mock.script([
      { tool_calls: [call('run_command', { command: `touch ${marker}` })] },
      { tool_calls: [call(REPORT_TOOL_NAME, CLEAN_REPORT)] },
    ]);
    const ui = scriptedUI({ confirms: [false] });
    const tools = createToolRegistry({ repoRoot: repo.root, role: 'implementer', ui });

    const report = await runAgent(baseOptions({ tools }));

    expect(report).toEqual(CLEAN_REPORT);
    // The user saw the exact command, denied it, and nothing executed.
    expect(ui.confirmed).toHaveLength(1);
    expect(ui.confirmed[0]).toContain(`touch ${marker}`);
    await expect(fs.access(marker)).rejects.toThrow();
    // The model received the denial as a tool error, not a crash.
    const second = chatMessages(mock, 1);
    const toolMessage = second[second.length - 1];
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.content).toContain('denied by user');
  });

  test('worker mode nudges plain text and the nudge counts toward the cap', async () => {
    mock.script([
      { content: 'I think I should read the spec first.' },
      { tool_calls: [call(REPORT_TOOL_NAME, CLEAN_REPORT)] },
    ]);

    const report = await runAgent(baseOptions());

    expect(report).toEqual(CLEAN_REPORT);
    const second = chatMessages(mock, 1);
    const nudge = second[second.length - 1];
    expect(nudge.role).toBe('user');
    expect(nudge.content).toContain('no tool call');
  });

  test('worker mode plain text past the cap fails the dispatch', async () => {
    mock.script(
      Array.from({ length: MALFORMED_CALL_CAP + 1 }, () => ({ content: 'still musing...' })),
    );

    const error = await runAgent(baseOptions({ task: 'T2' })).catch(e => e);

    expect(error).toBeInstanceOf(AgentLoopError);
    expect(error.message).toContain('T2');
    expect(error.message).toContain('malformed');
  });

  test('interview mode routes plain text through the UI and feeds the answer back', async () => {
    mock.script([
      { content: 'What is the mission of this feature?' },
      { tool_calls: [call(REPORT_TOOL_NAME, { spec_path: 'specs/001-x/spec.md' })] },
    ]);
    const ui = scriptedUI({ asks: ['Build a local SDD orchestrator.'] });
    const tools = createToolRegistry({ repoRoot: repo.root, role: 'supervisor', ui });

    const report = await runAgent(
      baseOptions({ role: 'supervisor', task: undefined, mode: 'interview', tools, ui }),
    );

    expect(report).toEqual({ spec_path: 'specs/001-x/spec.md' });
    expect(ui.asked).toEqual(['What is the mission of this feature?']);
    const second = chatMessages(mock, 1);
    const userReply = second[second.length - 1];
    expect(userReply.role).toBe('user');
    expect(userReply.content).toBe('Build a local SDD orchestrator.');
  });

  test('interview mode without a UI fails immediately', async () => {
    await expect(runAgent(baseOptions({ mode: 'interview', ui: undefined }))).rejects.toThrow(
      /interview mode requires an injected UI/,
    );
    expect(mock.chatRequests).toHaveLength(0);
  });

  test('an invalid report is returned as a tool error and a corrected report succeeds', async () => {
    mock.script([
      { tool_calls: [call(REPORT_TOOL_NAME, { verdict: 'MAYBE', details: 'unsure' })] },
      { tool_calls: [call(REPORT_TOOL_NAME, { verdict: 'PASS', details: 'verified tests' })] },
    ]);
    const tools = createToolRegistry({
      repoRoot: repo.root,
      role: 'critic',
      ui: scriptedUI(),
    });

    const report = await runAgent(baseOptions({ role: 'critic', tools }));

    expect(report).toEqual({ verdict: 'PASS', details: 'verified tests' });
    const second = chatMessages(mock, 1);
    expect(second[second.length - 1].content).toContain('invalid arguments for report');
  });

  test('report ends the dispatch even when later tool calls follow it', async () => {
    mock.script([
      {
        tool_calls: [
          call(REPORT_TOOL_NAME, CLEAN_REPORT),
          call('read_file', { path: 'notes.txt' }),
        ],
      },
    ]);

    const report = await runAgent(baseOptions());

    expect(report).toEqual(CLEAN_REPORT);
    expect(mock.chatRequests).toHaveLength(1);
  });
});
