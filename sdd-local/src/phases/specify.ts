/**
 * SPECIFY phase and Gate 1 (AC1, AC5 part).
 *
 * Dispatches the vendored supervisor prompt in interview mode through the
 * generic agent loop, with file tools sandboxed to the target repo. The
 * vendored spec template is provided to the model inside the dispatch
 * context (read from this package's prompts/templates/spec.md), never
 * through the sandbox: the template is not a file in the target repo.
 *
 * On the supervisor's report, the produced spec.md is validated: sections
 * 1 to 5 non-empty, section 6 empty, Status DRAFT. Validation failures
 * re-dispatch the supervisor with the error list, up to
 * VALIDATION_RETRY_CAP re-prompts, so a stuck model fails loudly instead
 * of hanging the orchestrator.
 *
 * Gate 1 is orchestrator code over the injected UI, never the model:
 *   - approve: status flips to SPECIFIED and the spec path is returned;
 *   - request changes: the interview re-enters with the user's feedback;
 *   - abort: the phase returns with no further writes.
 *
 * Gate enforcement is structural: this function returns only on approval
 * or abort, so the PLAN phase (and any plan.md or section 6 content)
 * cannot exist before Gate 1 approval.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { runAgent } from '../agent-loop';
import { loadPrompt, loadSpecTemplate } from '../prompts';
import { appendJournal, writeStatus } from '../spec-files';
import { createToolRegistry, ToolRegistry } from '../tools/registry';
import { resolveInRepo } from '../tools/sandbox';
import type { UI } from '../ui';

/**
 * Default chat-call cap per supervisor dispatch. In interview mode every
 * user question-and-answer round consumes one iteration, so this is sized
 * generously for a long interview plus the file writes around it.
 */
export const DEFAULT_SPECIFY_MAX_ITERATIONS = 100;

/** Validation re-prompts tolerated per interview; one more fails the phase. */
export const VALIDATION_RETRY_CAP = 3;

/** Gate 1 option labels, exported so tests and the CLI share the wording. */
export const GATE1_APPROVE = 'Approve the spec (continue to PLAN)';
export const GATE1_REQUEST_CHANGES = 'Request changes (back to the interview with feedback)';
export const GATE1_ABORT = 'Abort (stop here, nothing else is written)';

const OPENING_QUESTION = 'Describe the feature you want to build:';
const FEEDBACK_QUESTION = 'What should change in the spec?';

/** Thrown when the supervisor cannot produce a valid spec. */
export class SpecifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecifyError';
  }
}

export type SpecifyResult =
  | { outcome: 'approved'; specPath: string }
  | { outcome: 'aborted' };

export interface SpecifyOptions {
  /** Target repo root the supervisor's file tools are confined to. */
  repoRoot: string;
  /** Ollama base URL. */
  baseUrl: string;
  /** Model driving the supervisor role. */
  model: string;
  /** Injected terminal UI: interview answers and the Gate 1 decision. */
  ui: UI;
  /** Chat-call cap per dispatch. Default DEFAULT_SPECIFY_MAX_ITERATIONS. */
  maxIterations?: number;
  /** Progress line per chat call; inject a no-op in tests. */
  onProgress?: (line: string) => void;
}

const STATUS_LINE = /^> Status:[^\S\n]*(.*?)[^\S\n]*$/m;

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

/** Section body with HTML comments stripped and whitespace trimmed. */
function strippedSectionBody(lines: string[], start: number): string {
  const end = findNextHeading(lines, start);
  return lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/**
 * Validate a freshly produced spec.md against the Gate 1 contract:
 * Status DRAFT, headings 1 to 7 present, sections 1 to 5 non-empty, and
 * section 6 empty apart from the template's HTML comment. Returns the list
 * of validation errors; an empty list means the draft is valid.
 */
export function validateDraftSpec(content: string): string[] {
  const errors: string[] = [];

  const status = STATUS_LINE.exec(content);
  if (status === null) {
    errors.push('missing "> Status:" line');
  } else if (status[1] !== 'DRAFT') {
    errors.push(`Status must be DRAFT, found "${status[1]}"`);
  }

  const lines = content.split('\n');
  for (let section = 1; section <= 7; section++) {
    const start = findHeadingLine(lines, section);
    if (start === -1) {
      errors.push(`missing "## ${section}." section heading`);
      continue;
    }
    if (section <= 5 && strippedSectionBody(lines, start) === '') {
      errors.push(`section ${section} is empty; sections 1 to 5 must be filled`);
    }
    if (section === 6 && strippedSectionBody(lines, start) !== '') {
      errors.push(
        'section 6 must be empty (apart from the template comment) until the PLAN phase',
      );
    }
  }
  return errors;
}

/** The dispatch context shared by every supervisor (re-)dispatch. */
function buildBaseContext(template: string, openingRequest: string): string {
  return [
    'Conduct the SPECIFY interview and save the spec file.',
    '',
    "The user's opening request:",
    '',
    openingRequest,
    '',
    'The spec template to follow. It is provided here as context only; it is',
    'not a file in the target repo:',
    '',
    '<template>',
    template,
    '</template>',
  ].join('\n');
}

/**
 * Resolve and validate the spec path the supervisor reported. The path must
 * stay inside the repo root, exist, and pass validateDraftSpec.
 */
async function checkReportedSpec(
  repoRoot: string,
  reportedPath: string,
): Promise<{ specPath?: string; errors: string[] }> {
  let specPath: string;
  try {
    specPath = await resolveInRepo(repoRoot, reportedPath);
  } catch {
    return { errors: [`the reported spec_path resolves outside the target repo: ${reportedPath}`] };
  }
  let content: string;
  try {
    content = await fs.readFile(specPath, 'utf8');
  } catch {
    return {
      specPath,
      errors: [`the reported spec_path does not exist; save it with write_file first: ${reportedPath}`],
    };
  }
  return { specPath, errors: validateDraftSpec(content) };
}

interface SupervisorDispatch {
  repoRoot: string;
  baseUrl: string;
  model: string;
  ui: UI;
  maxIterations: number;
  onProgress?: (line: string) => void;
  systemPrompt: string;
  tools: ToolRegistry;
  /** Base context prepended to every re-dispatch. */
  base: string;
}

/**
 * Run supervisor dispatches until the reported spec.md passes validation,
 * re-prompting with the error list up to VALIDATION_RETRY_CAP times.
 * Returns the absolute path of the valid DRAFT spec.
 */
async function interviewUntilValid(
  dispatch: SupervisorDispatch,
  firstContext: string,
): Promise<string> {
  let context = firstContext;
  for (let attempt = 0; ; attempt++) {
    const report = await runAgent({
      role: 'supervisor',
      systemPrompt: dispatch.systemPrompt,
      context,
      tools: dispatch.tools,
      mode: 'interview',
      maxIterations: dispatch.maxIterations,
      baseUrl: dispatch.baseUrl,
      model: dispatch.model,
      ui: dispatch.ui,
      onProgress: dispatch.onProgress,
    });
    // The registry's supervisor report schema guarantees spec_path is a string.
    const reportedPath = report.spec_path as string;

    const { specPath, errors } = await checkReportedSpec(dispatch.repoRoot, reportedPath);
    if (specPath !== undefined && errors.length === 0) {
      return specPath;
    }
    if (attempt >= VALIDATION_RETRY_CAP) {
      throw new SpecifyError(
        `the supervisor's spec at "${reportedPath}" still failed validation after ` +
          `${attempt + 1} attempts (re-prompt cap is ${VALIDATION_RETRY_CAP}): ${errors.join('; ')}`,
      );
    }
    context = [
      dispatch.base,
      '',
      `Your previously saved spec at ${reportedPath} failed validation:`,
      ...errors.map((error) => `- ${error}`),
      '',
      'Revise spec.md to fix every error, save it again with write_file, and',
      'call report again.',
    ].join('\n');
  }
}

/**
 * Run the SPECIFY phase to completion: interview, validation, Gate 1.
 * Returns only on Gate 1 approval (spec status SPECIFIED) or abort (no
 * further writes), so no PLAN-phase work can precede the gate.
 */
export async function specify(options: SpecifyOptions): Promise<SpecifyResult> {
  const { repoRoot, baseUrl, model, ui, onProgress } = options;
  const maxIterations = options.maxIterations ?? DEFAULT_SPECIFY_MAX_ITERATIONS;

  const systemPrompt = loadPrompt('supervisor');
  const tools = createToolRegistry({ repoRoot, role: 'supervisor', ui });

  const openingRequest = await ui.ask(OPENING_QUESTION);
  const base = buildBaseContext(loadSpecTemplate(), openingRequest);
  const dispatch: SupervisorDispatch = {
    repoRoot,
    baseUrl,
    model,
    ui,
    maxIterations,
    onProgress,
    systemPrompt,
    tools,
    base,
  };

  let context = [
    base,
    '',
    'Begin the interview now: confirm what you can infer from the opening',
    'request and ask your first question.',
  ].join('\n');

  for (;;) {
    const specPath = await interviewUntilValid(dispatch, context);
    const relPath = path.relative(repoRoot, specPath);
    const journalPath = path.join(path.dirname(specPath), 'journal.md');

    // Gate 1 REQUIRES one of approve/request-changes/abort to branch on. Per
    // the resolved Q1 decision (and matching the drift gate in implement.ts) a
    // free-text escape ("Something else...") is treated as a note rather than a
    // fourth decision: we carry that text as a pending note and re-prompt until
    // the user picks one of the three options, so their input is never dropped
    // and the branch mapping below stays byte-identical.
    let note: string | undefined;
    let choice: string;
    for (;;) {
      const result = await ui.choose(
        `Gate 1: a draft spec was saved at ${relPath}. Review it, then choose:`,
        [GATE1_APPROVE, GATE1_REQUEST_CHANGES, GATE1_ABORT],
      );
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
    // journal write: Gate 1 does not journal today.
    if (note !== undefined) {
      await appendJournal(
        journalPath,
        `Gate 1 (${relPath}): user chose "${choice}" with note: ${note}`,
      );
    }

    if (choice === GATE1_APPROVE) {
      await writeStatus(specPath, 'SPECIFIED');
      return { outcome: 'approved', specPath };
    }
    if (choice === GATE1_ABORT) {
      return { outcome: 'aborted' };
    }

    // The request-changes branch consumes feedback. When a note (or carried
    // free text) is attached, it IS the feedback and the separate follow-up is
    // skipped; with no note, the follow-up question runs as before (AC8).
    const feedback =
      note !== undefined && note !== '' ? note : await ui.ask(FEEDBACK_QUESTION);
    context = [
      base,
      '',
      `Gate 1 feedback from the user on ${relPath}:`,
      '',
      feedback,
      '',
      'Revise spec.md accordingly, save it with write_file, and call report',
      'again. Ask follow-up questions only if the feedback is unclear.',
    ].join('\n');
  }
}
