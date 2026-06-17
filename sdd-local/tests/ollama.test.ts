import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import { startMockOllama, MockOllamaServer } from './helpers/mock-ollama';
import {
  chat,
  listModels,
  showCapabilities,
  ping,
  OllamaError,
  ChatMessage,
  ToolDefinition,
} from '../src/ollama';

const READ_FILE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from the repo',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

describe('ollama client', () => {
  let mock: MockOllamaServer;

  beforeAll(async () => {
    mock = await startMockOllama({ models: ['model-a', 'model-b'] });
  });

  afterAll(() => mock.close());

  beforeEach(() => mock.reset());

  describe('chat', () => {
    test('sends model, messages, stream:false, and tools, and returns content', async () => {
      mock.script([{ content: 'hello from the model' }]);
      const messages: ChatMessage[] = [
        { role: 'system', content: 'you are a test agent' },
        { role: 'user', content: 'say hello' },
      ];

      const result = await chat(mock.baseUrl, 'model-a', messages, [READ_FILE_TOOL]);

      expect(result.content).toBe('hello from the model');
      expect(result.toolCalls).toEqual([]);
      expect(mock.chatRequests).toHaveLength(1);
      expect(mock.chatRequests[0]).toEqual({
        model: 'model-a',
        messages,
        stream: false,
        tools: [READ_FILE_TOOL],
      });
    });

    test('omits the tools key when no tools are passed', async () => {
      mock.script([{ content: 'ok' }]);
      await chat(mock.baseUrl, 'model-a', [{ role: 'user', content: 'hi' }]);
      expect(mock.chatRequests[0]).not.toHaveProperty('tools');
    });

    test('sends tool-role messages with tool_name through verbatim', async () => {
      mock.script([{ content: 'done' }]);
      const messages: ChatMessage[] = [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
        },
        { role: 'tool', tool_name: 'read_file', content: 'file body' },
      ];
      await chat(mock.baseUrl, 'model-a', messages);
      expect((mock.chatRequests[0] as { messages: unknown }).messages).toEqual(messages);
    });

    test('normalizes tool_calls with object arguments', async () => {
      mock.script([
        {
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'spec.md' } } }],
        },
      ]);
      const result = await chat(mock.baseUrl, 'model-a', [{ role: 'user', content: 'go' }]);
      expect(result.toolCalls).toEqual([
        { name: 'read_file', arguments: { path: 'spec.md' } },
      ]);
    });

    test('normalizes tool_calls whose arguments are a JSON string', async () => {
      mock.script([
        {
          tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"spec.md"}' } }],
        },
      ]);
      const result = await chat(mock.baseUrl, 'model-a', [{ role: 'user', content: 'go' }]);
      expect(result.toolCalls).toEqual([
        { name: 'read_file', arguments: { path: 'spec.md' } },
      ]);
    });

    test('marks malformed string arguments instead of throwing', async () => {
      mock.script([
        {
          tool_calls: [
            { function: { name: 'read_file', arguments: '{not valid json' } },
            { function: { name: 'read_file', arguments: '"just a string"' } },
          ],
        },
      ]);
      const result = await chat(mock.baseUrl, 'model-a', [{ role: 'user', content: 'go' }]);

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].name).toBe('read_file');
      expect(result.toolCalls[0].arguments).toEqual({});
      expect(result.toolCalls[0].malformed).toContain('not valid JSON');
      expect(result.toolCalls[1].arguments).toEqual({});
      expect(result.toolCalls[1].malformed).toContain('not an object');
    });

    test('marks a tool call with no function name as malformed', async () => {
      mock.script([
        { tool_calls: [{ function: { name: '', arguments: { a: 1 } } }] },
      ]);
      const result = await chat(mock.baseUrl, 'model-a', [{ role: 'user', content: 'go' }]);
      expect(result.toolCalls[0].malformed).toContain('missing a function name');
    });

    test('throws OllamaError with status and detail on a non-2xx response', async () => {
      // No script entries: the mock answers /api/chat with HTTP 500.
      const err = await chat(mock.baseUrl, 'model-a', [{ role: 'user', content: 'go' }]).catch(
        e => e,
      );
      expect(err).toBeInstanceOf(OllamaError);
      expect(err.message).toContain('HTTP 500');
      expect(err.message).toContain('/api/chat');
    });

    test('throws OllamaError with an actionable message when unreachable', async () => {
      const closedUrl = await closedPortUrl();
      const err = await chat(closedUrl, 'model-a', [{ role: 'user', content: 'go' }]).catch(
        e => e,
      );
      expect(err).toBeInstanceOf(OllamaError);
      expect(err.message).toContain(closedUrl);
      expect(err.message).toContain('ollama serve');
    });
  });

  describe('listModels', () => {
    test('returns the model names from /api/tags', async () => {
      expect(await listModels(mock.baseUrl)).toEqual(['model-a', 'model-b']);
    });

    test('accepts a base URL with a trailing slash', async () => {
      expect(await listModels(`${mock.baseUrl}/`)).toEqual(['model-a', 'model-b']);
    });
  });

  describe('showCapabilities', () => {
    test('returns the capabilities for a model', async () => {
      mock.setCapabilities(['completion'], 'model-b');
      expect(await showCapabilities(mock.baseUrl, 'model-a')).toEqual([
        'completion',
        'tools',
      ]);
      expect(await showCapabilities(mock.baseUrl, 'model-b')).toEqual(['completion']);
    });

    test('returns undefined when the server does not report capabilities', async () => {
      const server = await startInlineServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ license: 'MIT' }));
      });
      try {
        expect(await showCapabilities(server.url, 'old-model')).toBeUndefined();
      } finally {
        await server.close();
      }
    });
  });

  describe('ping', () => {
    test('returns ok against a reachable server', async () => {
      expect(await ping(mock.baseUrl)).toEqual({ ok: true });
    });

    test('reports connection refused with an actionable hint', async () => {
      const closedUrl = await closedPortUrl();
      const result = await ping(closedUrl);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(closedUrl);
        expect(result.error).toContain('refused');
        expect(result.error).toContain('ollama serve');
      }
    });

    test('reports a timeout when the server never answers', async () => {
      const server = await startInlineServer(() => {
        // Never respond; let ping hit its timeout.
      });
      try {
        const result = await ping(server.url, 100);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain('Timed out');
          expect(result.error).toContain(server.url);
        }
      } finally {
        await server.close();
      }
    });

    test('reports a non-2xx response as an error', async () => {
      const server = await startInlineServer((req, res) => {
        res.writeHead(503);
        res.end('overloaded');
      });
      try {
        const result = await ping(server.url);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain('HTTP 503');
        }
      } finally {
        await server.close();
      }
    });
  });
});

/** Start a mock server, close it, and return its now-unreachable base URL. */
async function closedPortUrl(): Promise<string> {
  const sacrifice = await startMockOllama();
  const url = sacrifice.baseUrl;
  await sacrifice.close();
  return url;
}

interface InlineServer {
  url: string;
  close: () => Promise<void>;
}

/** Tiny throwaway HTTP server for response shapes the mock cannot produce. */
async function startInlineServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<InlineServer> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
