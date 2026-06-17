/**
 * PLAN phase and Gate 2 (AC2, AC5 part).
 *
 * Dispatches the vendored planner prompt in worker mode through the generic
 * agent loop, with context: spec path, repo root, and prior Gate 2 feedback
 * when re-dispatched. The planner is expected to write plan.md next to
 * spec.md and fill spec section 6 (appending to section 7 if needed).
 *
 * After the planner's report the orchestrator enforces containment against
 * a snapshot of spec.md taken before the dispatch:
 *   - sections 1 to 5 (everything before the "## 6." heading) must be
 *     byte-identical;
 *   - section 7 may only grow: the prior content must be preserved verbatim,
 *     with new entries appended after it.
 * Any violation restores the snapshot and fails the dispatch. The phase then
 * asserts plan.md exists and that section 6 parses into tasks that each
 * carry "verifies:" and "depends_on:" markers.
 *
 * Gate 2 is orchestrator code over the injected UI, never the model: the
 * approach summary and task list are presented, then
 *   - approve: status flips to PLANNED and the plan path is returned;
 *   - request changes: the planner is re-dispatched with the user's feedback;
 *   - abort: the phase returns with no further writes.
 *
 * Gate enforcement is structural: this function returns only on approval or
 * abort, so the IMPLEMENT phase (and any implementation file changes) cannot
 * exist before Gate 2 approval.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { runAgent } from '../agent-loop';
import { loadPrompt } from '../prompts';
import {
  appendJournal,
  assertSection7AppendOnly,
  assertSections1to5Unchanged,
  parseTasksFromContent,
  SpecTask,
  writeStatus,
} from '../spec-files';
import { createToolRegistry } from '../tools/registry';
import type { UI } from '../ui';

/** Default chat-call cap per planner dispatch: research, plan.md, spec edit. */
export const DEFAULT_PLAN_MAX_ITERATIONS = 50;

/** Gate 2 option labels, exported so tests and the CLI share the wording. */
export const GATE2_APPROVE = 'Approve the plan (continue to IMPLEMENT)';
export const GATE2_REQUEST_CHANGES = 'Request changes (re-dispatch the planner with feedback)';
export const GATE2_ABORT = 'Abort (stop here, nothing else is written)';

const FEEDBACK_QUESTION = 'What should change in the plan?';

/** Thrown when a planner dispatch fails its post-report checks. */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export type PlanResult =
  | { outcome: 'approved'; planPath: string }
  | { outcome: 'aborted' };

export interface PlanOptions {
  /** Target repo root the planner's tools are confined to. */
  repoRoot: string;
  /** Absolute path to the Gate 1 approved spec.md. */
  specPath: string;
  /** Ollama base URL. */
  baseUrl: string;
  /** Model driving the planner role. */
  model: string;
  /** Injected terminal UI: command confirmations and the Gate 2 decision. */
  ui: UI;
  /** Chat-call cap per dispatch. Default DEFAULT_PLAN_MAX_ITERATIONS. */
  maxIterations?: number;
  /** Progress line per chat call; inject a no-op in tests. */
  onProgress?: (line: string) => void;
}

/** The planner dispatch context: spec path, repo root, prior feedback. */
function buildContext(specRelPath: string, repoRoot: string, feedback?: string): string {
  const lines = [
    'Produce the technical plan for this approved spec.',
    '',
    `Spec path: ${specRelPath}`,
    `Repo root: ${repoRoot}`,
    '',
    'Write plan.md in the same folder as the spec, fill spec section 6 with',
    'the task breakdown, and call report when you are done.',
  ];
  if (feedback !== undefined) {
    lines.push(
      '',
      'Gate 2 feedback from the user on your previous plan:',
      '',
      feedback,
      '',
      'Address each point: update plan.md and spec section 6 accordingly,',
      'then call report again.',
    );
  }
  return lines.join('\n');
}

/** Index of the "## N." heading line, or -1 when absent. */
function findHeadingLine(lines: string[], section: number): number {
  const re = new RegExp(`^##\\s*${section}\\.`);
  return lines.findIndex((line) => re.test(line));
}

/** Index of the next "## " heading after `start`, or lines.length. */
function findNextHeading(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) return i;
  }
  return lines.length;
}

/** Lines of the section 6 body (between the "## 6." and next heading). */
function section6Lines(content: string): string[] {
  const lines = content.split('\n');
  const start = findHeadingLine(lines, 6);
  if (start === -1) {
    throw new PlanError('the planner left spec.md without a "## 6." section heading');
  }
  return lines.slice(start + 1, findNextHeading(lines, start));
}

/**
 * Validate the section 6 task breakdown the planner wrote: at least one
 * task, every checkbox line in the exact task format, and every task naming
 * the acceptance criteria it verifies. depends_on is enforced by the format
 * itself ("none" parses to an empty list, which is valid).
 */
function checkTaskBreakdown(specContent: string): SpecTask[] {
  let tasks: SpecTask[];
  try {
    tasks = parseTasksFromContent(specContent);
  } catch (error) {
    throw new PlanError(
      `the planner's spec.md has no parseable section 6: ${(error as Error).message}`,
    );
  }

  const checkboxLines = section6Lines(specContent).filter((line) =>
    /^\s*\d+\.\s+\[[ x]\]/.test(line),
  );
  if (checkboxLines.length !== tasks.length) {
    throw new PlanError(
      'spec section 6 has task lines that do not match the required format ' +
        '"N. [ ] TN: description - verifies: AC1 - depends_on: none": ' +
        'every task needs "verifies:" and "depends_on:" markers',
    );
  }
  if (tasks.length === 0) {
    throw new PlanError('the planner reported done but spec section 6 contains no tasks');
  }
  for (const task of tasks) {
    if (task.verifies.length === 0) {
      throw new PlanError(`task ${task.id} in spec section 6 has no "verifies:" entries`);
    }
  }
  return tasks;
}

/**
 * Post-report checks for one planner dispatch. Containment violations
 * restore the pre-dispatch snapshot before failing; all failures throw
 * PlanError. Returns the parsed section 6 tasks on success.
 */
async function checkPlannerOutput(
  specPath: string,
  planPath: string,
  planRelPath: string,
  snapshot: string,
): Promise<SpecTask[]> {
  const after = await fs.readFile(specPath, 'utf8');
  try {
    assertSections1to5Unchanged(snapshot, after);
    assertSection7AppendOnly(snapshot, after);
  } catch (error) {
    await fs.writeFile(specPath, snapshot, 'utf8');
    throw new PlanError(
      'planner containment violation, spec.md restored to its pre-dispatch ' +
        `state: ${(error as Error).message}`,
    );
  }

  try {
    await fs.access(planPath);
  } catch {
    throw new PlanError(`the planner reported done but ${planRelPath} does not exist`);
  }

  return checkTaskBreakdown(after);
}

/** The Gate 2 presentation: approach summary, task list, planner notes. */
function gateLabel(
  planRelPath: string,
  summary: string,
  tasks: SpecTask[],
  gateNotes: string | undefined,
): string {
  const lines = [
    `Gate 2: the planner wrote ${planRelPath} and filled spec section 6.`,
    '',
    'Approach summary:',
    summary,
    '',
    'Task breakdown:',
    ...tasks.map(
      (task) =>
        `  ${task.number}. [${task.checked ? 'x' : ' '}] ${task.id}: ${task.description}` +
        ` - verifies: ${task.verifies.join(', ')}` +
        ` - depends_on: ${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none'}`,
    ),
  ];
  if (gateNotes !== undefined && gateNotes.trim() !== '') {
    lines.push('', 'Planner notes for this gate:', gateNotes);
  }
  lines.push('', `Review ${planRelPath} and spec section 6, then choose:`);
  return lines.join('\n');
}

/**
 * Run the PLAN phase to completion: planner dispatch, containment checks,
 * Gate 2. Returns only on Gate 2 approval (spec status PLANNED) or abort
 * (no further writes), so no IMPLEMENT-phase work can precede the gate.
 */
export async function plan(options: PlanOptions): Promise<PlanResult> {
  const { repoRoot, specPath, baseUrl, model, ui, onProgress } = options;
  const maxIterations = options.maxIterations ?? DEFAULT_PLAN_MAX_ITERATIONS;

  const systemPrompt = loadPrompt('planner');
  const tools = createToolRegistry({ repoRoot, role: 'planner', ui });
  const planPath = path.join(path.dirname(specPath), 'plan.md');
  const journalPath = path.join(path.dirname(specPath), 'journal.md');
  const specRelPath = path.relative(repoRoot, specPath);
  const planRelPath = path.relative(repoRoot, planPath);

  let feedback: string | undefined;
  for (;;) {
    // Snapshot before each dispatch, so re-dispatch containment is checked
    // against the latest accepted state (sections 1 to 5 never legally
    // change after Gate 1, and section 7 appends accumulate).
    const snapshot = await fs.readFile(specPath, 'utf8');

    const report = await runAgent({
      role: 'planner',
      systemPrompt,
      context: buildContext(specRelPath, repoRoot, feedback),
      tools,
      mode: 'worker',
      maxIterations,
      baseUrl,
      model,
      ui,
      onProgress,
    });

    const tasks = await checkPlannerOutput(specPath, planPath, planRelPath, snapshot);

    // The registry's planner report schema guarantees summary is a string.
    const summary = report.summary as string;
    const gateNotes = typeof report.gate_notes === 'string' ? report.gate_notes : undefined;

    // Gate 2 REQUIRES one of approve/request-changes/abort to branch on. Per
    // the resolved Q1 decision (and matching Gate 1 in specify.ts) a free-text
    // escape ("Something else...") is treated as a note rather than a fourth
    // decision: we carry that text as a pending note and re-prompt until the
    // user picks one of the three options, so their input is never dropped and
    // the branch mapping below stays byte-identical.
    let note: string | undefined;
    let choice: string;
    for (;;) {
      const result = await ui.choose(gateLabel(planRelPath, summary, tasks, gateNotes), [
        GATE2_APPROVE,
        GATE2_REQUEST_CHANGES,
        GATE2_ABORT,
      ]);
      if ('freeText' in result) {
        note = result.freeText;
        continue;
      }
      choice = result.option;
      if (result.note !== undefined) note = result.note;
      break;
    }

    // Per the resolved Q3 decision, an attached note is journaled on ANY branch
    // (approve, request-changes, abort) when one is present. This is a NEW
    // journal write: Gate 2 does not journal today.
    if (note !== undefined) {
      await appendJournal(
        journalPath,
        `Gate 2 (${planRelPath}): user chose "${choice}" with note: ${note}`,
      );
    }

    if (choice === GATE2_APPROVE) {
      await writeStatus(specPath, 'PLANNED');
      return { outcome: 'approved', planPath };
    }
    if (choice === GATE2_ABORT) {
      return { outcome: 'aborted' };
    }
    // The request-changes branch consumes feedback. When a note (or carried
    // free text) is attached, it IS the feedback and the separate follow-up is
    // skipped; with no note, the follow-up question runs as before (AC8).
    feedback =
      note !== undefined && note !== '' ? note : await ui.ask(FEEDBACK_QUESTION);
  }
}
