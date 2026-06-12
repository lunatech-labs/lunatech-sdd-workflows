import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { startMockOllama, MockOllamaServer } from './helpers/mock-ollama';
import { makeTempRepo } from './helpers/temp-repo';

describe('mock-ollama', () => {
  let mock: MockOllamaServer;

  beforeAll(async () => {
    mock = await startMockOllama({ models: ['model-a', 'model-b'] });
  });

  afterAll(() => mock.close());

  beforeEach(() => mock.reset());

  test('GET /api/tags returns the configured model list', async () => {
    const res = await fetch(`${mock.baseUrl}/api/tags`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ models: [{ name: 'model-a' }, { name: 'model-b' }] });
  });

  test('setModels changes the /api/tags response', async () => {
    mock.setModels(['only-one']);
    const body = await (await fetch(`${mock.baseUrl}/api/tags`)).json();
    expect(body.models).toEqual([{ name: 'only-one' }]);
    mock.setModels(['model-a', 'model-b']);
  });

  test('POST /api/show returns default and per-model capabilities', async () => {
    mock.setCapabilities(['completion'], 'model-b');
    const show = (model: string) =>
      fetch(`${mock.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      }).then(r => r.json());

    expect(await show('model-a')).toEqual({ capabilities: ['completion', 'tools'] });
    expect(await show('model-b')).toEqual({ capabilities: ['completion'] });
  });

  test('scripted tool_calls round-trip through /api/chat, object and string arguments', async () => {
    mock.script([
      {
        content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: { path: 'spec.md' } } },
        ],
      },
      {
        tool_calls: [
          { function: { name: 'report', arguments: '{"status":"done"}' } },
        ],
      },
    ]);

    const chat = (messages: unknown) =>
      fetch(`${mock.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'model-a', messages, stream: false }),
      }).then(r => r.json());

    const first = await chat([{ role: 'user', content: 'go' }]);
    expect(first.message.role).toBe('assistant');
    expect(first.message.tool_calls).toEqual([
      { function: { name: 'read_file', arguments: { path: 'spec.md' } } },
    ]);

    const second = await chat([{ role: 'user', content: 'continue' }]);
    expect(second.message.tool_calls[0].function.name).toBe('report');
    // String form survives verbatim so clients must parse defensively.
    expect(second.message.tool_calls[0].function.arguments).toBe('{"status":"done"}');
  });

  test('script entries match on role-prompt markers and are consumed once', async () => {
    mock.script([
      { match: 'you are the critic', content: 'critic reply' },
      { match: 'you are the planner', content: 'planner reply' },
      { content: 'fallback reply' },
    ]);

    const chat = (system: string) =>
      fetch(`${mock.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'model-a',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: 'go' },
          ],
        }),
      }).then(r => r.json());

    // Planner marker skips the critic entry and takes the planner one.
    expect((await chat('you are the planner agent')).message.content).toBe('planner reply');
    // Unmatched marker falls through to the unconditional entry.
    expect((await chat('you are the implementer')).message.content).toBe('fallback reply');
    // Critic entry is still waiting and gets consumed exactly once.
    expect((await chat('you are the critic agent')).message.content).toBe('critic reply');
    expect(mock.pendingReplies).toBe(0);
  });

  test('chat with no matching script entry returns 500, not a silent default', async () => {
    const res = await fetch(`${mock.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('no scripted reply');
  });

  test('records every request body for assertions', async () => {
    mock.script([{ content: 'ok' }]);
    const chatBody = {
      model: 'model-a',
      messages: [{ role: 'user', content: 'record me' }],
      stream: false,
      tools: [{ type: 'function', function: { name: 'report', parameters: {} } }],
    };
    await fetch(`${mock.baseUrl}/api/tags`);
    await fetch(`${mock.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody),
    });

    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0]).toMatchObject({ method: 'GET', path: '/api/tags' });
    expect(mock.requests[1]).toMatchObject({ method: 'POST', path: '/api/chat' });
    expect(mock.requests[1].body).toEqual(chatBody);
    expect(mock.chatRequests).toEqual([chatBody]);
  });

  test('unknown routes return 404', async () => {
    const res = await fetch(`${mock.baseUrl}/api/nope`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('temp-repo', () => {
  test('creates a directory, seeds nested files, and cleans up', async () => {
    const repo = await makeTempRepo({
      files: {
        'README.md': 'hello\n',
        'specs/001-x/spec.md': '# Spec\n',
      },
    });
    expect(path.isAbsolute(repo.root)).toBe(true);
    expect(await repo.readFile('README.md')).toBe('hello\n');
    expect(await repo.readFile('specs/001-x/spec.md')).toBe('# Spec\n');

    await repo.writeFile('notes/extra.txt', 'more');
    expect(await repo.readFile('notes/extra.txt')).toBe('more');

    await repo.cleanup();
    await expect(fs.stat(repo.root)).rejects.toThrow();
  });

  test('git: true initializes a repo; commit: true gives history and a clean tree', async () => {
    const repo = await makeTempRepo({
      git: true,
      commit: true,
      files: { 'a.txt': 'a\n' },
    });
    try {
      expect((await fs.stat(path.join(repo.root, '.git'))).isDirectory()).toBe(true);
      expect((await repo.git('rev-parse', 'HEAD')).trim()).toMatch(/^[0-9a-f]{40}$/);
      expect((await repo.git('status', '--porcelain')).trim()).toBe('');

      // Dirty it and observe the porcelain output, the shape T10 will rely on.
      await repo.writeFile('a.txt', 'changed\n');
      expect((await repo.git('status', '--porcelain')).trim()).not.toBe('');
    } finally {
      await repo.cleanup();
    }
  });

  test('plain temp repo has no git directory', async () => {
    const repo = await makeTempRepo();
    try {
      await expect(fs.stat(path.join(repo.root, '.git'))).rejects.toThrow();
    } finally {
      await repo.cleanup();
    }
  });

  test('commit without git is rejected', async () => {
    await expect(makeTempRepo({ commit: true })).rejects.toThrow(/requires git/);
  });
});
