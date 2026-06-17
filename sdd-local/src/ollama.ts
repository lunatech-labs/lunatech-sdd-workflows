/**
 * Plain-fetch client for the Ollama HTTP API.
 *
 * Endpoints used:
 *   - POST /api/chat  (stream: false, optional tools)  -> chat()
 *   - GET  /api/tags                                   -> listModels(), ping()
 *   - POST /api/show                                   -> showCapabilities()
 *
 * No LLM framework, no streaming. Errors are surfaced as OllamaError with
 * clear, actionable messages (connection refused, timeout, non-2xx).
 */

/** Roles in an Ollama chat conversation. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** Tool call in the wire shape Ollama expects when replaying history. */
export interface WireToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/** A message sent to /api/chat. `tool_name` is required for role "tool". */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Name of the tool this message is the result of (role "tool" only). */
  tool_name?: string;
  /** Tool calls on an assistant message being replayed as history. */
  tool_calls?: WireToolCall[];
}

/** OpenAI-style tool definition as Ollama accepts in the `tools` array. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A tool call from the model, normalized: `arguments` is always an object.
 * Ollama documents arguments as a JSON object, but real models sometimes
 * return a JSON string; both are accepted. When the raw arguments cannot be
 * parsed into an object, `arguments` is {} and `malformed` explains why, so
 * the agent loop can hand the error back to the model instead of crashing.
 */
export interface NormalizedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  malformed?: string;
}

/** Assistant reply from chat(): text content plus normalized tool calls. */
export interface ChatResult {
  content: string;
  toolCalls: NormalizedToolCall[];
}

export type PingResult = { ok: true } | { ok: false; error: string };

/** Error for any failed interaction with the Ollama API. */
export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaError';
  }
}

const PING_TIMEOUT_MS = 5_000;

/**
 * One non-streaming chat turn. Returns the assistant message content and
 * normalized tool calls. `tools` is sent only when provided and non-empty.
 */
export async function chat(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<ChatResult> {
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (tools !== undefined && tools.length > 0) {
    body.tools = tools;
  }
  const json = await requestJson(baseUrl, '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const message = (json as { message?: unknown })?.message;
  if (message === undefined || message === null || typeof message !== 'object') {
    throw new OllamaError(
      `Ollama at ${baseUrl} returned a /api/chat response without a message object.`,
    );
  }
  const { content, tool_calls } = message as { content?: unknown; tool_calls?: unknown };
  return {
    content: typeof content === 'string' ? content : '',
    toolCalls: normalizeToolCalls(tool_calls),
  };
}

/** Names of the models installed on the Ollama instance, via GET /api/tags. */
export async function listModels(baseUrl: string): Promise<string[]> {
  const json = await requestJson(baseUrl, '/api/tags', { method: 'GET' });
  const models = (json as { models?: unknown })?.models;
  if (!Array.isArray(models)) {
    throw new OllamaError(
      `Ollama at ${baseUrl} returned a /api/tags response without a models array.`,
    );
  }
  return models
    .map(m => (m as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Capabilities of one model via POST /api/show, e.g. ["completion", "tools"].
 * Returns undefined when the server does not report capabilities (older
 * Ollama versions omit the field), so callers can warn "could not verify"
 * instead of treating it as "no tool support".
 */
export async function showCapabilities(
  baseUrl: string,
  model: string,
): Promise<string[] | undefined> {
  const json = await requestJson(baseUrl, '/api/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const capabilities = (json as { capabilities?: unknown })?.capabilities;
  if (!Array.isArray(capabilities)) {
    return undefined;
  }
  return capabilities.filter((c): c is string => typeof c === 'string');
}

/**
 * Startup reachability check against GET /api/tags. Never throws: returns
 * { ok: false, error } with an actionable message on connection refused,
 * timeout, or a non-2xx response.
 */
export async function ping(
  baseUrl: string,
  timeoutMs: number = PING_TIMEOUT_MS,
): Promise<PingResult> {
  try {
    await requestJson(baseUrl, '/api/tags', { method: 'GET' }, timeoutMs);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}

/** Normalize raw tool_calls from a chat response. Never throws. */
function normalizeToolCalls(raw: unknown): NormalizedToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(call => {
    const fn = (call as { function?: unknown })?.function as
      | { name?: unknown; arguments?: unknown }
      | undefined;
    const name = typeof fn?.name === 'string' ? fn.name : '';
    if (name === '') {
      return {
        name: '',
        arguments: {},
        malformed: 'tool call is missing a function name',
      };
    }
    const rawArgs = fn?.arguments;
    if (rawArgs === undefined || rawArgs === null) {
      return { name, arguments: {} };
    }
    if (typeof rawArgs === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawArgs);
      } catch {
        return {
          name,
          arguments: {},
          malformed: `tool call arguments are not valid JSON: ${rawArgs}`,
        };
      }
      if (isPlainObject(parsed)) {
        return { name, arguments: parsed };
      }
      return {
        name,
        arguments: {},
        malformed: `tool call arguments JSON is not an object: ${rawArgs}`,
      };
    }
    if (isPlainObject(rawArgs)) {
      return { name, arguments: rawArgs };
    }
    return {
      name,
      arguments: {},
      malformed: 'tool call arguments are neither an object nor a JSON string',
    };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fetch JSON from the Ollama API, converting every failure mode into an
 * OllamaError with an actionable message.
 */
async function requestJson(
  baseUrl: string,
  apiPath: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, '')}${apiPath}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    throw new OllamaError(describeFetchFailure(baseUrl, err));
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).trim();
    } catch {
      // Body unavailable: report status alone.
    }
    throw new OllamaError(
      `Ollama at ${baseUrl} responded with HTTP ${res.status} for ${apiPath}` +
        (detail !== '' ? `: ${detail}` : '.') +
        ` Check that ollamaBaseUrl points at an Ollama server.`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new OllamaError(
      `Ollama at ${baseUrl} returned invalid JSON for ${apiPath}.` +
        ` Check that ollamaBaseUrl points at an Ollama server.`,
    );
  }
}

function describeFetchFailure(baseUrl: string, err: unknown): string {
  const hint =
    `Is Ollama running at ${baseUrl}?` +
    ` Start it with "ollama serve" or fix ollamaBaseUrl in sdd.config.json.`;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `Timed out waiting for Ollama at ${baseUrl}. ${hint}`;
  }
  if (errorCode(err) === 'ECONNREFUSED') {
    return `Connection refused at ${baseUrl}. ${hint}`;
  }
  const reason = err instanceof Error ? err.message : String(err);
  return `Could not reach Ollama at ${baseUrl} (${reason}). ${hint}`;
}

/** Dig the system error code (e.g. ECONNREFUSED) out of a fetch failure. */
function errorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: unknown })?.cause;
  if (cause === undefined || cause === null || typeof cause !== 'object') {
    return undefined;
  }
  const c = cause as { code?: unknown; errors?: unknown };
  if (typeof c.code === 'string') {
    return c.code;
  }
  if (Array.isArray(c.errors)) {
    const first = c.errors.find(
      e => typeof (e as { code?: unknown })?.code === 'string',
    );
    if (first !== undefined) {
      return (first as { code: string }).code;
    }
  }
  return undefined;
}
