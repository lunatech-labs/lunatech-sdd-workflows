/**
 * IMPLEMENT loop (AC3, AC4, AC12).
 *
 * Sets the spec status to IN PROGRESS, then drives every unchecked section 6
 * task strictly in order. Each task is one implementer worker dispatch (spec
 * path, plan path, single task ID, plus the critic's feedback when retrying)
 * followed by one critic worker dispatch (the same refs plus the
 * implementer's report).
 *
 * Verdict handling, all orchestrator code, never the model:
 *   - PASS: tick the task checkbox in spec.md, append the verdict to
 *     journal.md, and emit a one-line progress note through the injectable
 *     output.
 *   - FAIL: re-dispatch the implementer with the critic's specific failures,
 *     at most MAX_TASK_RETRIES times per task; after the last failed retry
 *     the loop stops, the critic's report is shown to the user, and the
 *     escalation is returned to the caller.
 *   - DRIFT (from either agent): the report is appended to journal.md, the
 *     loop stops, and the user decides (continue, amend, or abort) before
 *     anything else runs. Continue re-dispatches the reporting agent with a
 *     note that the user chose to proceed per the current spec and plan;
 *     amend and abort end the phase.
 *
 * Loop state lives entirely in spec.md checkboxes and journal.md, so the
 * boundary between tasks is a safe stopping point: amend, abort, or a killed
 * process all resume task-level via Phase 0 orient.
 */
import * as path from 'node:path';
import { runAgent } from '../agent-loop';
import { loadPrompt } from '../prompts';
import { appendJournal, parseTasks, tickTask, writeStatus } from '../spec-files';
import { createToolRegistry } from '../tools/registry';
import type { UI } from '../ui';

/** Default chat-call cap per dispatch; implement tasks read, write, and test. */
export const DEFAULT_IMPLEMENT_MAX_ITERATIONS = 100;

/** Implementer re-dispatches allowed after a critic FAIL, per task. */
export const MAX_TASK_RETRIES = 2;

/** Drift decision labels, exported so tests and the CLI share the wording. */
export const DRIFT_CONTINUE =
  'Continue (proceed with this task per the current spec and plan)';
export const DRIFT_AMEND =
  'Amend (stop the loop to amend the spec or plan; resume re-enters via Phase 0)';
export const DRIFT_ABORT = 'Abort (stop the implement loop now)';

/** Which agent reported the drift. */
export type DriftReporter = 'implementer' | 'critic';

export type ImplementResult =
  | { outcome: 'complete' }
  | { outcome: 'escalated'; taskId: string; criticDetails: string }
  | {
      outcome: 'drift';
      taskId: string;
      reportedBy: DriftReporter;
      decision: 'amend' | 'abort';
      details: string;
    };

export interface ImplementOptions {
  /** Target repo root the agents' tools are confined to. */
  repoRoot: string;
  /** Absolute path to the Gate 2 approved spec.md. */
  specPath: string;
  /** Absolute path to the Gate 2 approved plan.md. */
  planPath: string;
  /** Ollama base URL. */
  baseUrl: string;
  /** Model driving the implementer role. */
  implementerModel: string;
  /** Model driving the critic role. */
  criticModel: string;
  /** Injected terminal UI: command confirmations and drift decisions. */
  ui: UI;
  /** Chat-call cap per dispatch. Default DEFAULT_IMPLEMENT_MAX_ITERATIONS. */
  maxIterations?: number;
  /** Progress and escalation lines; inject a collector in tests. */
  onProgress?: (line: string) => void;
}

/** The implementer's report, as guaranteed by the registry's report schema. */
interface ImplementerReport {
  taskId: string;
  changes: string;
  verification: string;
  status: 'CLEAN' | 'DRIFT';
  details?: string;
}

function readImplementerReport(raw: Record<string, unknown>): ImplementerReport {
  return {
    taskId: raw.task_id as string,
    changes: raw.changes as string,
    verification: raw.verification as string,
    status: raw.status as 'CLEAN' | 'DRIFT',
    details: typeof raw.details === 'string' ? raw.details : undefined,
  };
}

const CONTINUE_NOTE =
  'The user reviewed the drift report and decided to continue:';

/** Dispatch context for one implementer attempt at one task. */
function implementerContext(
  specRelPath: string,
  planRelPath: string,
  taskId: string,
  criticFeedback: string | undefined,
  driftNote: string | undefined,
): string {
  const lines = [
    'Implement exactly one task from the approved spec.',
    '',
    `Spec path: ${specRelPath}`,
    `Plan path: ${planRelPath}`,
    `Task ID: ${taskId}`,
    '',
    "Follow the plan's approach for this task, run the verification it",
    'specifies, and call report when you are done.',
  ];
  if (criticFeedback !== undefined) {
    lines.push(
      '',
      'The critic reviewed your previous attempt at this task and returned',
      'FAIL. Address each failure point specifically, then call report again:',
      '',
      criticFeedback,
    );
  }
  if (driftNote !== undefined) {
    lines.push(
      '',
      'You previously reported DRIFT on this task:',
      '',
      driftNote,
      '',
      `${CONTINUE_NOTE} implement the task per the current spec and plan as written.`,
    );
  }
  return lines.join('\n');
}

/** Dispatch context for one critic verification of one task. */
function criticContext(
  specRelPath: string,
  planRelPath: string,
  taskId: string,
  report: ImplementerReport,
  driftNote: string | undefined,
): string {
  const lines = [
    'Verify one implemented task against the spec and plan.',
    '',
    `Spec path: ${specRelPath}`,
    `Plan path: ${planRelPath}`,
    `Task ID: ${taskId}`,
    '',
    "The implementer's report:",
    '',
    `Status: ${report.status}`,
    'Changes:',
    report.changes,
    'Verification claimed:',
    report.verification,
    '',
    'Re-run the verification yourself, check the work against the spec and',
    'plan, and call report with your verdict.',
  ];
  if (driftNote !== undefined) {
    lines.push(
      '',
      'You previously reported DRIFT on this task:',
      '',
      driftNote,
      '',
      `${CONTINUE_NOTE} judge the work against the current spec and plan as written.`,
    );
  }
  return lines.join('\n');
}

/** Outcome of one task's inner loop. */
type TaskOutcome =
  | { kind: 'pass' }
  | { kind: 'escalated'; criticDetails: string }
  | { kind: 'drift'; reportedBy: DriftReporter; decision: 'amend' | 'abort'; details: string };

/**
 * Run the IMPLEMENT phase over every unchecked task, strictly sequentially.
 * Returns when all tasks are checked (complete), when a task is escalated
 * after MAX_TASK_RETRIES failed retries, or when the user answers a drift
 * report with amend or abort.
 */
export async function implement(options: ImplementOptions): Promise<ImplementResult> {
  const { repoRoot, specPath, planPath, baseUrl, implementerModel, criticModel, ui } = options;
  const maxIterations = options.maxIterations ?? DEFAULT_IMPLEMENT_MAX_ITERATIONS;
  const onProgress =
    options.onProgress ?? ((line: string) => process.stderr.write(`${line}\n`));

  const implementerPrompt = loadPrompt('implementer');
  const criticPrompt = loadPrompt('critic');
  const implementerTools = createToolRegistry({ repoRoot, role: 'implementer', ui });
  const criticTools = createToolRegistry({ repoRoot, role: 'critic', ui });

  const specRelPath = path.relative(repoRoot, specPath);
  const planRelPath = path.relative(repoRoot, planPath);
  const journalPath = path.join(path.dirname(specPath), 'journal.md');

  /**
   * Drift rule (AC12): journal the report first, then stop and ask the user.
   * The decision is journaled too, so the record explains what happened next.
   */
  const handleDrift = async (
    taskId: string,
    reportedBy: DriftReporter,
    details: string,
  ): Promise<'continue' | 'amend' | 'abort'> => {
    await appendJournal(journalPath, `${taskId}: DRIFT reported by the ${reportedBy}\n\n${details}`);
    const label = [
      `Task ${taskId}: the ${reportedBy} reported DRIFT, meaning the spec or`,
      'plan may be wrong, ambiguous, or incomplete. The implement loop is',
      'stopped. Drift report:',
      '',
      details,
      '',
      'How should we proceed?',
    ].join('\n');
    const choice = await ui.select(label, [DRIFT_CONTINUE, DRIFT_AMEND, DRIFT_ABORT]);
    const decision =
      choice === DRIFT_CONTINUE ? 'continue' : choice === DRIFT_AMEND ? 'amend' : 'abort';
    await appendJournal(journalPath, `${taskId}: user decision on the drift: ${decision}`);
    return decision;
  };

  /** The per-task inner loop: implementer, critic, retries, drift handling. */
  const runTask = async (taskId: string): Promise<TaskOutcome> => {
    let retries = 0;
    let criticFeedback: string | undefined;
    let implementerDriftNote: string | undefined;
    let criticDriftNote: string | undefined;
    // Set after a CLEAN implementer report; cleared when a retry re-opens
    // the implementation. While set, the loop goes straight to the critic.
    let implementerReport: ImplementerReport | undefined;

    for (;;) {
      if (implementerReport === undefined) {
        const raw = await runAgent({
          role: 'implementer',
          task: taskId,
          systemPrompt: implementerPrompt,
          context: implementerContext(
            specRelPath,
            planRelPath,
            taskId,
            criticFeedback,
            implementerDriftNote,
          ),
          tools: implementerTools,
          mode: 'worker',
          maxIterations,
          baseUrl,
          model: implementerModel,
          ui,
          onProgress,
        });
        const report = readImplementerReport(raw);
        if (report.status === 'DRIFT') {
          const details = report.details ?? 'no details provided';
          const decision = await handleDrift(taskId, 'implementer', details);
          if (decision !== 'continue') {
            return { kind: 'drift', reportedBy: 'implementer', decision, details };
          }
          implementerDriftNote = details;
          continue;
        }
        implementerReport = report;
      }

      const verdictRaw = await runAgent({
        role: 'critic',
        task: taskId,
        systemPrompt: criticPrompt,
        context: criticContext(specRelPath, planRelPath, taskId, implementerReport, criticDriftNote),
        tools: criticTools,
        mode: 'worker',
        maxIterations,
        baseUrl,
        model: criticModel,
        ui,
        onProgress,
      });
      // The registry's critic report schema guarantees both fields.
      const verdict = verdictRaw.verdict as 'PASS' | 'FAIL' | 'DRIFT';
      const details = verdictRaw.details as string;

      if (verdict === 'PASS') {
        await tickTask(specPath, taskId);
        await appendJournal(journalPath, `${taskId}: critic verdict PASS\n\n${details}`);
        onProgress(`Task ${taskId}: critic PASS, checkbox ticked.`);
        return { kind: 'pass' };
      }

      if (verdict === 'DRIFT') {
        const decision = await handleDrift(taskId, 'critic', details);
        if (decision !== 'continue') {
          return { kind: 'drift', reportedBy: 'critic', decision, details };
        }
        criticDriftNote = details;
        continue; // re-dispatch the critic over the same implementation
      }

      // FAIL: retry the implementer with the critic's failures, capped.
      if (retries >= MAX_TASK_RETRIES) {
        await appendJournal(
          journalPath,
          `${taskId}: critic verdict FAIL after ${retries} retries; escalated to the user\n\n${details}`,
        );
        onProgress(
          `Task ${taskId}: critic FAIL after ${MAX_TASK_RETRIES} retries. Stopping. Critic report:`,
        );
        onProgress(details);
        return { kind: 'escalated', criticDetails: details };
      }
      retries += 1;
      criticFeedback = details;
      implementerReport = undefined;
      criticDriftNote = undefined;
    }
  };

  await writeStatus(specPath, 'IN PROGRESS');

  for (;;) {
    // Re-parse each round: the boundary between tasks is a safe stopping
    // point, and the checkboxes in spec.md are the only loop state.
    const tasks = await parseTasks(specPath);
    const next = tasks.find(task => !task.checked);
    if (next === undefined) {
      return { outcome: 'complete' };
    }
    const outcome = await runTask(next.id);
    if (outcome.kind === 'pass') continue;
    if (outcome.kind === 'escalated') {
      return { outcome: 'escalated', taskId: next.id, criticDetails: outcome.criticDetails };
    }
    return {
      outcome: 'drift',
      taskId: next.id,
      reportedBy: outcome.reportedBy,
      decision: outcome.decision,
      details: outcome.details,
    };
  }
}
