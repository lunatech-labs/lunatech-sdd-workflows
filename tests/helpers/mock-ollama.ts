/**
 * Scriptable mock Ollama HTTP server for tests.
 *
 * Serves the three endpoints the orchestrator uses:
 *   - GET  /api/tags  -> { models: [{ name }] }            (configurable list)
 *   - POST /api/show  -> { capabilities: [...] }            (configurable, per model)
 *   - POST /api/chat  -> { message: { role, content, tool_calls? } }
 *
 * /api/chat replays a script of canned assistant replies. Each script entry
 * may carry a `match` marker: the entry is only used for requests whose
 * messages (system prompt included) contain that marker, so different role
 * agents get different replies. Entries without `match` apply to any request.
 * Entries are consumed in order, at most once each.
 *
 * Every request body is recorded for assertions.
 */
import * as http from 'node:http';

/** A tool call as Ollama returns it. `arguments` is normally a JSON object,
 * but real models sometimes return a JSON string; scripts may use either. */
export interface MockToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface MockChatReply {
  /** Only use this entry when some message content in the request contains
   * this marker. Omit to match any request. */
  match?: string;
  content?: string;
  tool_calls?: MockToolCall[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface MockOllamaOptions {
  /** Model names returned by GET /api/tags. */
  models?: string[];
  /** Capabilities returned by POST /api/show when the requested model has no
   * per-model entry. Defaults to ["completion", "tools"]. */
  capabilities?: string[];
}

export class MockOllamaServer {
  readonly server: http.Server;
  /** Every request received, in order. */
  readonly requests: RecordedRequest[] = [];
  /** Bodies of POST /api/chat requests only, in order. */
  readonly chatRequests: unknown[] = [];

  private models: string[];
  private defaultCapabilities: string[];
  private capabilitiesByModel = new Map<string, string[]>();
  private chatScript: MockChatReply[] = [];
  private listenPort = 0;

  constructor(options: MockOllamaOptions = {}) {
    this.models = options.models ?? ['mock-model'];
    this.defaultCapabilities = options.capabilities ?? ['completion', 'tools'];
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  get port(): number {
    return this.listenPort;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.listenPort}`;
  }

  async listen(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.listenPort = (this.server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close(err => (err ? reject(err) : resolve())),
    );
  }

  setModels(models: string[]): void {
    this.models = models;
  }

  /** Set capabilities for one model, or the default when model is omitted. */
  setCapabilities(capabilities: string[], model?: string): void {
    if (model === undefined) {
      this.defaultCapabilities = capabilities;
    } else {
      this.capabilitiesByModel.set(model, capabilities);
    }
  }

  /** Append entries to the /api/chat script. */
  script(replies: MockChatReply[]): void {
    this.chatScript.push(...replies);
  }

  /** Drop any unconsumed script entries and recorded requests. */
  reset(): void {
    this.chatScript = [];
    this.requests.length = 0;
    this.chatRequests.length = 0;
  }

  /** Script entries scripted but not yet consumed. */
  get pendingReplies(): number {
    return this.chatScript.length;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      this.requests.push({ method: req.method ?? '', path: req.url ?? '', body });

      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/api/tags') {
        return json(res, 200, { models: this.models.map(name => ({ name })) });
      }
      if (req.method === 'POST' && url === '/api/show') {
        const model = (body as { model?: string } | undefined)?.model ?? '';
        const capabilities = this.capabilitiesByModel.get(model) ?? this.defaultCapabilities;
        return json(res, 200, { capabilities });
      }
      if (req.method === 'POST' && url === '/api/chat') {
        this.chatRequests.push(body);
        return this.handleChat(body, res);
      }
      return json(res, 404, { error: `mock-ollama: no route for ${req.method} ${url}` });
    });
  }

  private handleChat(body: unknown, res: http.ServerResponse): void {
    const messages = (body as { messages?: Array<{ content?: unknown }> })?.messages ?? [];
    const haystack = messages
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    const index = this.chatScript.findIndex(
      entry => entry.match === undefined || haystack.includes(entry.match),
    );
    if (index === -1) {
      return json(res, 500, {
        error: 'mock-ollama: no scripted reply matches this /api/chat request',
      });
    }
    const [entry] = this.chatScript.splice(index, 1);

    const message: Record<string, unknown> = {
      role: 'assistant',
      content: entry.content ?? '',
    };
    if (entry.tool_calls) {
      message.tool_calls = entry.tool_calls;
    }
    const model = (body as { model?: string } | undefined)?.model ?? 'mock-model';
    return json(res, 200, { model, message, done: true });
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Create, start, and return a mock server listening on an ephemeral port. */
export async function startMockOllama(
  options: MockOllamaOptions = {},
): Promise<MockOllamaServer> {
  const server = new MockOllamaServer(options);
  await server.listen();
  return server;
}
