/**
 * Spec artifact operations over the vendored template structure (AC3, AC10):
 * spec.md numbering, status line, section 6 task parsing and ticking,
 * containment assertions for the PLAN phase, append-only journal.md, and
 * resume detection.
 *
 * All functions operate on supplied paths (or supplied content strings for
 * the pure assertions), so temp-repo tests can drive them directly.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Spec lifecycle statuses, in order. */
export const SPEC_STATUSES = ['DRAFT', 'SPECIFIED', 'PLANNED', 'IN PROGRESS', 'DONE'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/** One parsed section 6 task line. */
export interface SpecTask {
  /** Ordinal from the numbered list ("3. [ ] ..." gives 3). */
  number: number;
  /** Task ID, e.g. "T3". */
  id: string;
  /** True when the checkbox is ticked ("[x]"). */
  checked: boolean;
  /** Task description between "TN:" and " - verifies:". */
  description: string;
  /** Acceptance criterion IDs from "verifies:". */
  verifies: string[];
  /** Task IDs from "depends_on:"; empty when "none". */
  dependsOn: string[];
}

/** A spec.md that still has unchecked section 6 tasks. */
export interface ResumableSpec {
  /** Absolute path to the spec.md. */
  specPath: string;
  /** The first unchecked task, in list order. */
  firstUnchecked: SpecTask;
  /** Total number of unchecked tasks. */
  uncheckedCount: number;
}

const STATUS_LINE = /^> Status:[^\S\n]*(.*?)[^\S\n]*$/m;

/**
 * Task line format defined by prompts/templates/spec.md and prompts/planner.md:
 *   `N. [ ] TN: description - verifies: AC1, AC2 - depends_on: none`
 * The description match is greedy so descriptions may themselves contain
 * " - "; the trailing "verifies" and "depends_on" markers anchor the parse.
 */
const TASK_LINE =
  /^\s*(\d+)\.\s+\[([ x])\]\s+(T\d+):\s+(.+)\s+-\s+verifies:\s+(.+?)\s+-\s+depends_on:\s+(.+?)\s*$/;

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

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Allocate the next `NNN-slug` spec directory under `specsRoot` (001, 002,
 * ...), creating it (and the specs root if needed). Returns its absolute path.
 */
export async function nextSpecDir(specsRoot: string, slug: string): Promise<string> {
  await fs.mkdir(specsRoot, { recursive: true });
  const entries = await fs.readdir(specsRoot, { withFileTypes: true });
  let max = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^(\d{3})-/.exec(entry.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const dir = path.join(specsRoot, `${String(max + 1).padStart(3, '0')}-${slug}`);
  await fs.mkdir(dir);
  return dir;
}

/** Read the value of the `> Status:` line. */
export async function readStatus(specPath: string): Promise<string> {
  const content = await fs.readFile(specPath, 'utf8');
  const match = STATUS_LINE.exec(content);
  if (!match) {
    throw new Error(`no "> Status:" line found in ${specPath}`);
  }
  return match[1];
}

/**
 * Rewrite the `> Status:` line to the given status, leaving every other byte
 * of the file unchanged.
 */
export async function writeStatus(specPath: string, status: SpecStatus): Promise<void> {
  const content = await fs.readFile(specPath, 'utf8');
  if (!STATUS_LINE.test(content)) {
    throw new Error(`no "> Status:" line found in ${specPath}`);
  }
  const updated = content.replace(STATUS_LINE, `> Status: ${status}`);
  await fs.writeFile(specPath, updated, 'utf8');
}

/**
 * Parse section 6 task lines from spec.md content. Lines inside section 6
 * that do not match the task format (comments, blanks) are ignored; task-like
 * lines outside section 6 are never parsed. Throws when the file has no
 * section 6 heading.
 */
export function parseTasksFromContent(content: string): SpecTask[] {
  const lines = content.split('\n');
  const start = findHeadingLine(lines, 6);
  if (start === -1) {
    throw new Error('no "## 6." section heading found in spec content');
  }
  const end = findNextHeading(lines, start);
  const tasks: SpecTask[] = [];
  for (let i = start + 1; i < end; i++) {
    const match = TASK_LINE.exec(lines[i]);
    if (!match) continue;
    const dependsRaw = match[6].trim();
    tasks.push({
      number: Number(match[1]),
      id: match[3],
      checked: match[2] === 'x',
      description: match[4],
      verifies: splitCsv(match[5]),
      dependsOn: dependsRaw.toLowerCase() === 'none' ? [] : splitCsv(dependsRaw),
    });
  }
  return tasks;
}

/** Read and parse the section 6 tasks of the spec.md at `specPath`. */
export async function parseTasks(specPath: string): Promise<SpecTask[]> {
  return parseTasksFromContent(await fs.readFile(specPath, 'utf8'));
}

/**
 * Tick the checkbox of one section 6 task ("[ ]" to "[x]"), leaving every
 * other byte of the file unchanged. Idempotent when the task is already
 * checked; throws when the task ID is not found in section 6.
 */
export async function tickTask(specPath: string, taskId: string): Promise<void> {
  const content = await fs.readFile(specPath, 'utf8');
  const lines = content.split('\n');
  const start = findHeadingLine(lines, 6);
  if (start === -1) {
    throw new Error(`no "## 6." section heading found in ${specPath}`);
  }
  const end = findNextHeading(lines, start);
  for (let i = start + 1; i < end; i++) {
    const match = TASK_LINE.exec(lines[i]);
    if (!match || match[3] !== taskId) continue;
    if (match[2] === 'x') return; // already checked
    lines[i] = lines[i].replace('[ ]', '[x]');
    await fs.writeFile(specPath, lines.join('\n'), 'utf8');
    return;
  }
  throw new Error(`task ${taskId} not found in section 6 of ${specPath}`);
}

/**
 * Replace the body of section 6 (everything between the "## 6." heading and
 * the next "## " heading) with `newBody`, normalized to one blank line on
 * each side. All other sections are left byte-identical.
 */
export async function replaceSection6(specPath: string, newBody: string): Promise<void> {
  const content = await fs.readFile(specPath, 'utf8');
  const lines = content.split('\n');
  const start = findHeadingLine(lines, 6);
  if (start === -1) {
    throw new Error(`no "## 6." section heading found in ${specPath}`);
  }
  const end = findNextHeading(lines, start);
  const bodyLines = newBody.replace(/^\n+/, '').replace(/\n+$/, '').split('\n');
  const updated = [...lines.slice(0, start + 1), '', ...bodyLines, '', ...lines.slice(end)];
  await fs.writeFile(specPath, updated.join('\n'), 'utf8');
}

/** Everything before the "## 6." heading line (title, status, sections 1-5). */
function contentBeforeSection6(content: string, label: string): string {
  const lines = content.split('\n');
  const start = findHeadingLine(lines, 6);
  if (start === -1) {
    throw new Error(`no "## 6." section heading found in the ${label} content`);
  }
  return lines.slice(0, start).join('\n');
}

/** The "## 7." heading and everything after it. */
function contentFromSection7(content: string, label: string): string {
  const lines = content.split('\n');
  const start = findHeadingLine(lines, 7);
  if (start === -1) {
    throw new Error(`no "## 7." section heading found in the ${label} content`);
  }
  return lines.slice(start).join('\n');
}

/**
 * Containment check for the PLAN phase: everything before the section 6
 * heading (title, status line, sections 1 to 5) must be byte-identical
 * between the two spec.md contents. Throws on any difference.
 */
export function assertSections1to5Unchanged(before: string, after: string): void {
  const beforePrefix = contentBeforeSection6(before, 'before');
  const afterPrefix = contentBeforeSection6(after, 'after');
  if (beforePrefix === afterPrefix) return;
  const beforeLines = beforePrefix.split('\n');
  const afterLines = afterPrefix.split('\n');
  let i = 0;
  while (i < beforeLines.length && i < afterLines.length && beforeLines[i] === afterLines[i]) {
    i++;
  }
  throw new Error(
    `sections 1 to 5 (or the spec header) changed: first difference at line ${i + 1}`,
  );
}

/**
 * Containment check for the PLAN phase: section 7 may only grow. The prior
 * section 7 content must be preserved verbatim, with new entries appearing
 * only after it. Throws on any edit, deletion, or insertion before the
 * existing content.
 */
export function assertSection7AppendOnly(before: string, after: string): void {
  const beforeSection = contentFromSection7(before, 'before');
  const afterSection = contentFromSection7(after, 'after');
  if (!afterSection.startsWith(beforeSection)) {
    throw new Error(
      'section 7 is append-only: prior content must be preserved verbatim, ' +
        'with new entries added only after it',
    );
  }
}

/**
 * Append one timestamped entry to journal.md, creating the file (and parent
 * directories) when missing. Uses fs.appendFile, so existing content is never
 * truncated or rewritten. `now` is injectable for tests.
 */
export async function appendJournal(
  journalPath: string,
  entry: string,
  now: Date = new Date(),
): Promise<void> {
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  const block = `## ${now.toISOString()}\n\n${entry.trimEnd()}\n\n`;
  await fs.appendFile(journalPath, block, 'utf8');
}

async function collectSpecFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable directory: nothing to scan
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSpecFiles(full, out);
    } else if (entry.isFile() && entry.name === 'spec.md') {
      out.push(full);
    }
  }
}

/**
 * Find every spec.md under `specsRoot` that still has unchecked section 6
 * tasks, for Phase 0 resume (AC10). Specs without a section 6 heading or
 * without unchecked tasks are skipped. Returns results sorted by path, so
 * the lowest-numbered spec comes first.
 */
export async function findResumableSpecs(specsRoot: string): Promise<ResumableSpec[]> {
  const specFiles: string[] = [];
  await collectSpecFiles(specsRoot, specFiles);
  specFiles.sort();

  const resumable: ResumableSpec[] = [];
  for (const specPath of specFiles) {
    let tasks: SpecTask[];
    try {
      tasks = await parseTasks(specPath);
    } catch {
      continue; // no section 6: not a resumable spec
    }
    const unchecked = tasks.filter((task) => !task.checked);
    if (unchecked.length > 0) {
      resumable.push({
        specPath,
        firstUnchecked: unchecked[0],
        uncheckedCount: unchecked.length,
      });
    }
  }
  return resumable;
}
