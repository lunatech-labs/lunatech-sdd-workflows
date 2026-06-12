/**
 * Opt-in end-to-end smoke test against a real local Ollama model (AC11).
 *
 * Exists specifically to validate real tool-call parsing: one worker
 * dispatch through runAgent with the real tool registry in a temp repo. The
 * model is told to read a seeded file containing a random token and finish
 * by calling report with that token; the token can only come from a real,
 * correctly parsed read_file round trip.
 *
 * Gating: runs only when SDD_SMOKE=1, SDD_SMOKE_MODEL names an installed
 * model (never hardcoded here), and Ollama answers a live ping. Otherwise
 * the suite is describe.skip with the reason in its name: skipped, never
 * failed. Optional SDD_SMOKE_OLLAMA_URL overrides the default base URL.
 *
 * Real models are slow with stream:false; the test timeout is generous.
 */
import { describe, test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../src/agent-loop';
import { DEFAULT_OLLAMA_BASE_URL } from '../src/config';
import { ping } from '../src/ollama';
import { createToolRegistry } from '../src/tools/registry';
import type { UI } from '../src/ui';
import { makeTempRepo } from './helpers/temp-repo';

const SMOKE_TIMEOUT_MS = 300_000;
const MAX_ITERATIONS = 8;

const smokeRequested = process.env.SDD_SMOKE === '1';
const model = process.env.SDD_SMOKE_MODEL ?? '';
const baseUrl = process.env.SDD_SMOKE_OLLAMA_URL ?? DEFAULT_OLLAMA_BASE_URL;

let skipReason: string | null = null;
if (!smokeRequested) {
  skipReason = 'opt in with SDD_SMOKE=1';
} else if (model === '') {
  skipReason =
    'SDD_SMOKE=1 but SDD_SMOKE_MODEL is unset; set it to an installed Ollama model (see "ollama list")';
} else {
  const alive = await ping(baseUrl);
  if (!alive.ok) {
    skipReason = `Ollama is unreachable at ${baseUrl}: ${alive.error}`;
  }
}

if (smokeRequested && skipReason !== null) {
  // The user opted in but the smoke cannot run; say why on stderr directly,
  // since vitest does not print the names of skipped suites by default.
  process.stderr.write(`smoke test skipped: ${skipReason}\n`);
}

const smokeDescribe = skipReason === null ? describe : describe.skip;
const title =
  skipReason === null
    ? `real-Ollama smoke (model ${model})`
    : `real-Ollama smoke (skipped: ${skipReason})`;

/** Worker dispatches never ask; any run_command is denied, not executed. */
const ui: UI = {
  async ask() {
    throw new Error('smoke: worker mode must not ask the user');
  },
  async confirm() {
    return false;
  },
  async select() {
    throw new Error('smoke: select is not available');
  },
  async readAnswer() {
    throw new Error('smoke: worker mode must not read an answer');
  },
};

const SYSTEM_PROMPT = [
  'You are a worker agent that acts only through tool calls.',
  'Plain text replies do nothing: every step must be exactly one tool call.',
  'Complete the task given in the first user message, then call the report',
  'tool exactly once to finish your dispatch.',
].join(' ');

smokeDescribe(title, () => {
  test(
    'worker dispatch reads a seeded file and reports its content via real tool calls',
    { timeout: SMOKE_TIMEOUT_MS },
    async () => {
      const token = `smoke-token-${randomUUID()}`;
      const repo = await makeTempRepo({
        files: { 'notes/message.txt': `${token}\n` },
      });
      try {
        const tools = createToolRegistry({ repoRoot: repo.root, role: 'implementer', ui });
        const context = [
          'Task SMOKE: the file notes/message.txt in this repo contains one',
          'secret token on its first line.',
          'Step 1: call read_file with path "notes/message.txt" to get the token.',
          'Step 2: call report with task_id "SMOKE", status "CLEAN",',
          'verification "read notes/message.txt", and changes set to the exact',
          'token you read, character for character.',
          'Do not run any shell commands and do not write any files.',
        ].join(' ');

        const report = await runAgent({
          role: 'implementer',
          task: 'SMOKE',
          systemPrompt: SYSTEM_PROMPT,
          context,
          tools,
          mode: 'worker',
          maxIterations: MAX_ITERATIONS,
          baseUrl,
          model,
          ui,
        });

        // The token is random and lives only in the seeded file, so its
        // presence proves a real read_file tool call was parsed, executed,
        // and its result fed back to the model.
        expect(report.status).toBe('CLEAN');
        expect(JSON.stringify(report)).toContain(token);
      } finally {
        await repo.cleanup();
      }
    },
  );
});
