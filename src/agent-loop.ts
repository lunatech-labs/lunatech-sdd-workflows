/**
 * Generic agentic loop: one function drives any role over the Ollama chat
 * client (src/ollama.ts) and a role-specific tool registry
 * (src/tools/registry.ts).
 *
 * Per iteration: POST /api/chat with the conversation and the role's tool
 * definitions, then execute the returned tool_calls in order, appending each
 * result as a role "tool" message. A valid `report` call ends the dispatch
 * and its arguments are returned as the structured result.
 *
 * Guards (AC15):
 *   - maxIterations chat calls per dispatch; exceeding it throws an
 *     AgentLoopError naming the role and task.
 *   - Malformed calls (unknown tool, unparseable or invalid arguments,
 *     including the malformed flag set by the Ollama client) are returned to
 *     the model as tool errors, up to MALFORMED_CALL_CAP per dispatch;
 *     one more fails the dispatch.
 *
 * Modes:
 *   - interview: plain assistant text is shown to the user through the
 *     injected UI and the typed answer becomes the next user message
 *     (the supervisor's SPECIFY interview).
 *   - worker: plain assistant text without tool calls gets a corrective
 *     nudge, which counts toward the malformed-call cap.
 *
 * Because chat is non-streaming, every chat call prints a "model thinking"
 * progress line so long waits do not look like hangs; onProgress is
 * injectable so tests stay quiet.
 */
import { chat, ChatMessage, WireToolCall } from './ollama';
import type { UI } from './ui';
import { AgentRole, REPORT_TOOL_NAME, ToolRegistry } from './tools/registry';

/** Malformed tool calls tolerated per dispatch; one more fails it. */
export const MALFORMED_CALL_CAP = 3;

/** Thrown when a dispatch fails: iteration cap or malformed-call cap. */
export class AgentLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoopError';
  }
}

export type AgentMode = 'interview' | 'worker';

export interface RunAgentOptions {
  role: AgentRole;
  /** Task label for error messages, e.g. "T3". Omit for non-task dispatches. */
  task?: string;
  /** The vendored role prompt. */
  systemPrompt: string;
  /** Dispatch context (spec path, plan path, task ID, feedback): the first user message. */
  context: string;
  tools: ToolRegistry;
  mode: AgentMode;
  /** Max chat calls for this dispatch. */
  maxIterations: number;
  /** Ollama base URL. */
  baseUrl: string;
  /** Model to drive this role. */
  model: string;
  /** Required in interview mode: plain assistant text goes through ui.ask. */
  ui?: UI;
  /** Progress line per chat call. Defaults to stderr; inject a no-op in tests. */
  onProgress?: (line: string) => void;
}

const WORKER_NUDGE =
  'You replied with plain text but no tool call. Text alone does nothing. ' +
  'Call one of your tools to act, or call the report tool to finish.';

function describeDispatch(role: AgentRole, task: string | undefined): string {
  return `agent "${role}"${task !== undefined ? ` (task ${task})` : ''}`;
}

/**
 * Run one agent dispatch to completion. Resolves with the structured
 * arguments of the agent's `report` call.
 */
export async function runAgent(options: RunAgentOptions): Promise<Record<string, unknown>> {
  const { role, task, systemPrompt, context, tools, mode, maxIterations, baseUrl, model, ui } =
    options;
  const onProgress =
    options.onProgress ?? ((line: string) => process.stderr.write(`${line}\n`));

  if (mode === 'interview' && ui === undefined) {
    throw new AgentLoopError(
      `${describeDispatch(role, task)}: interview mode requires an injected UI`,
    );
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: context },
  ];

  let malformedCount = 0;
  const countMalformed = (lastError: string): void => {
    malformedCount += 1;
    if (malformedCount > MALFORMED_CALL_CAP) {
      throw new AgentLoopError(
        `${describeDispatch(role, task)} failed after ${malformedCount} malformed tool calls ` +
          `(cap is ${MALFORMED_CALL_CAP}). Last error: ${lastError}`,
      );
    }
  };

  const toolErrorMessage = (toolName: string, error: string): ChatMessage => ({
    role: 'tool',
    tool_name: toolName === '' ? 'unknown' : toolName,
    content: `tool error: ${error}`,
  });

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    onProgress(`[${role}] model ${model} is thinking (step ${iteration}/${maxIterations})...`);
    const reply = await chat(baseUrl, model, messages, tools.definitions);

    const assistant: ChatMessage = { role: 'assistant', content: reply.content };
    if (reply.toolCalls.length > 0) {
      assistant.tool_calls = reply.toolCalls.map(
        (call): WireToolCall => ({ function: { name: call.name, arguments: call.arguments } }),
      );
    }
    messages.push(assistant);

    if (reply.toolCalls.length === 0) {
      const text = reply.content.trim();
      if (mode === 'interview' && text !== '') {
        const answer = await (ui as UI).ask(text);
        messages.push({ role: 'user', content: answer });
        continue;
      }
      countMalformed(
        text === '' ? 'assistant message was empty, with no tool call' : 'assistant message had no tool call',
      );
      messages.push({ role: 'user', content: WORKER_NUDGE });
      continue;
    }

    for (const call of reply.toolCalls) {
      if (call.malformed !== undefined) {
        countMalformed(call.malformed);
        messages.push(toolErrorMessage(call.name, call.malformed));
        continue;
      }
      if (call.name === REPORT_TOOL_NAME) {
        const valid = tools.validateReport(call.arguments);
        if (!valid.ok) {
          const error = `invalid arguments for report: ${valid.error}`;
          countMalformed(error);
          messages.push(toolErrorMessage(call.name, error));
          continue;
        }
        return call.arguments;
      }
      const result = await tools.execute(call.name, call.arguments);
      if (result.ok) {
        messages.push({ role: 'tool', tool_name: call.name, content: result.output });
      } else {
        if (result.malformed === true) {
          countMalformed(result.error);
        }
        messages.push(toolErrorMessage(call.name, result.error));
      }
    }
  }

  throw new AgentLoopError(
    `${describeDispatch(role, task)} exceeded the ${maxIterations}-iteration cap ` +
      `without calling ${REPORT_TOOL_NAME}.`,
  );
}
