/**
 * PRESENT phase (AC14).
 *
 * Reads spec.md and journal.md and reports how the run went:
 *   - every section 5 acceptance criterion is printed with a verification
 *     status derived from the section 6 task checkboxes (via each task's
 *     "verifies:" mapping) and the critic PASS verdicts recorded in
 *     journal.md;
 *   - every drift report recorded in journal.md is listed;
 *   - when all section 6 tasks are checked, the spec status is set to DONE.
 *
 * Pure reporting plus the one DONE transition: no agents are dispatched and
 * no gate is involved. Output goes through an injectable sink so the whole
 * flow stays scriptable in tests.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseTasksFromContent, readStatus, writeStatus } from '../spec-files';

/** Verification status of one acceptance criterion. */
export type CriterionVerification =
  | 'VERIFIED' // every task verifying it is checked (at least one task)
  | 'PARTIALLY VERIFIED' // some verifying tasks checked, some not
  | 'UNVERIFIED' // tasks map to it, none checked
  | 'NOT COVERED'; // no section 6 task names it in "verifies:"

export interface CriterionStatus {
  /** Criterion ID, e.g. "AC3". */
  id: string;
  /** The criterion text after "ACn:". */
  text: string;
  verification: CriterionVerification;
  /** The tasks whose "verifies:" lists this criterion, in section 6 order. */
  tasks: Array<{ id: string; checked: boolean; criticPass: boolean }>;
}

/** One drift report recorded in journal.md by the IMPLEMENT loop. */
export interface DriftEntry {
  taskId: string;
  reporter: string;
  details: string;
}

export interface PresentResult {
  /** True when all section 6 tasks are checked and the status was set DONE. */
  done: boolean;
  criteria: CriterionStatus[];
  drift: DriftEntry[];
}

export interface PresentOptions {
  /** Target repo root, used to print repo-relative paths. */
  repoRoot: string;
  /** Absolute path to the spec.md to report on. */
  specPath: string;
  /** Output sink, one line per call. Default: console.log. */
  out?: (line: string) => void;
}

/** Acceptance criterion line in section 5:
 *  `- [ ] AC4 (retries): When the critic returns FAIL, ...` */
const AC_LINE = /^\s*-\s+\[[ x]\]\s+(AC\d+)\s*(?:\([^)]*\))?\s*:\s*(.*)$/;

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

/** Parse the section 5 acceptance criteria: ID and text, in order. */
function parseCriteria(content: string): Array<{ id: string; text: string }> {
  const lines = content.split('\n');
  const start = findHeadingLine(lines, 5);
  if (start === -1) return [];
  const end = findNextHeading(lines, start);
  const criteria: Array<{ id: string; text: string }> = [];
  for (let i = start + 1; i < end; i++) {
    const match = AC_LINE.exec(lines[i]);
    if (match) criteria.push({ id: match[1], text: match[2] });
  }
  return criteria;
}

/**
 * Parse journal.md as the IMPLEMENT loop wrote it: one `## <timestamp>`
 * block per entry. Returns the set of task IDs with a critic PASS verdict
 * and every drift report.
 */
function parseJournal(content: string): { passes: Set<string>; drift: DriftEntry[] } {
  const passes = new Set<string>();
  const drift: DriftEntry[] = [];
  // Each appendJournal entry starts with a "## <timestamp>" heading line.
  const blocks = content.split(/^## .*$/m);
  for (const block of blocks) {
    const body = block.trim();
    const pass = /^(T\d+): critic verdict PASS\b/.exec(body);
    if (pass !== null) {
      passes.add(pass[1]);
      continue;
    }
    const reported = /^(T\d+): DRIFT reported by the (\w+)\n+([\s\S]*)$/.exec(body);
    if (reported !== null) {
      drift.push({ taskId: reported[1], reporter: reported[2], details: reported[3].trim() });
    }
  }
  return { passes, drift };
}

function verificationOf(
  tasks: Array<{ checked: boolean }>,
): CriterionVerification {
  if (tasks.length === 0) return 'NOT COVERED';
  const checked = tasks.filter((task) => task.checked).length;
  if (checked === tasks.length) return 'VERIFIED';
  if (checked > 0) return 'PARTIALLY VERIFIED';
  return 'UNVERIFIED';
}

/**
 * Run the PRESENT phase: print the acceptance-criteria summary and the
 * recorded drift, and set the spec status to DONE when every section 6 task
 * is checked. Returns the computed summary for the caller.
 */
export async function present(options: PresentOptions): Promise<PresentResult> {
  const { repoRoot, specPath } = options;
  const out = options.out ?? ((line: string) => console.log(line));

  const content = await fs.readFile(specPath, 'utf8');
  const tasks = parseTasksFromContent(content);
  const criteria = parseCriteria(content);

  const journalPath = path.join(path.dirname(specPath), 'journal.md');
  let journalContent = '';
  try {
    journalContent = await fs.readFile(journalPath, 'utf8');
  } catch {
    // No journal yet: nothing was implemented or recorded.
  }
  const { passes, drift } = parseJournal(journalContent);

  const criterionStatuses: CriterionStatus[] = criteria.map((criterion) => {
    const verifying = tasks
      .filter((task) => task.verifies.includes(criterion.id))
      .map((task) => ({
        id: task.id,
        checked: task.checked,
        criticPass: passes.has(task.id),
      }));
    return {
      id: criterion.id,
      text: criterion.text,
      verification: verificationOf(verifying),
      tasks: verifying,
    };
  });

  const specRelPath = path.relative(repoRoot, specPath);
  out(`PRESENT: ${specRelPath}`);
  out('');
  out('Acceptance criteria:');
  if (criterionStatuses.length === 0) {
    out('  (none found in section 5)');
  }
  for (const criterion of criterionStatuses) {
    out(`  ${criterion.id}: ${criterion.verification}`);
    out(`    ${criterion.text}`);
    if (criterion.tasks.length === 0) {
      out('    tasks: none mapped in section 6');
    } else {
      const summary = criterion.tasks
        .map(
          (task) =>
            `${task.id} [${task.checked ? 'x' : ' '}]` +
            (task.criticPass ? ' (critic PASS)' : ''),
        )
        .join(', ');
      out(`    tasks: ${summary}`);
    }
  }

  out('');
  out('Drift recorded:');
  if (drift.length === 0) {
    out('  none');
  }
  for (const entry of drift) {
    out(`  - ${entry.taskId}: DRIFT reported by the ${entry.reporter}`);
    for (const line of entry.details.split('\n')) {
      out(`      ${line}`);
    }
  }

  out('');
  const checkedCount = tasks.filter((task) => task.checked).length;
  const done = tasks.length > 0 && checkedCount === tasks.length;
  if (done) {
    await writeStatus(specPath, 'DONE');
    out(`All ${tasks.length} tasks are checked. Spec status set to DONE.`);
  } else {
    const status = await readStatus(specPath);
    out(
      `${checkedCount} of ${tasks.length} tasks checked. ` +
        `Spec status remains ${status}.`,
    );
  }

  return { done, criteria: criterionStatuses, drift };
}
