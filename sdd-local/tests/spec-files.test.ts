import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { makeTempRepo, TempRepo } from './helpers/temp-repo';
import {
  nextSpecDir,
  readStatus,
  writeStatus,
  parseTasks,
  parseTasksFromContent,
  tickTask,
  replaceSection6,
  assertSections1to5Unchanged,
  assertSection7AppendOnly,
  appendJournal,
  findResumableSpecs,
} from '../src/spec-files';

const DEFAULT_TASKS = [
  '1. [x] T1: Project scaffold: package.json, strict tsconfig, vitest - verifies: AC1 - depends_on: none',
  '2. [ ] T2: Core module - with a hyphenated aside - verifies: AC1, AC2 - depends_on: T1',
  '3. [ ] T3: CLI wiring - verifies: AC3 - depends_on: T1, T2',
];

function sampleSpec(
  options: { status?: string; tasks?: readonly string[] } = {},
): string {
  const status = options.status ?? 'PLANNED';
  const tasks = options.tasks ?? DEFAULT_TASKS;
  return `# Feature Spec: Sample Feature

> Status: ${status}
> Spec folder: specs/001-sample-feature/

## 1. Mission / Why

Solve the sample problem for sample users.

## 2. Outcome

A user can run the sample and see a result.

## 3. Scope

### In scope

- Sample thing one

### Out of scope

- Sample thing two

## 4. Constraints & Decisions

- Language / framework: TypeScript

## 5. Acceptance Criteria (how you'll verify it)

- [ ] AC1: Given input, when action, then result
- [ ] AC2 (edge case): when unusual input, the system copes
- [ ] AC3 (errors): when failure, the system reports it

## 6. Task Breakdown

<!-- Filled in by the planner, approved by the user at Gate 2. -->

${tasks.join('\n')}

## 7. Open Questions

- Is the sample open question resolved?
`;
}

const SPEC_REL = 'specs/001-sample-feature/spec.md';

describe('spec-files', () => {
  let repo: TempRepo;
  let specPath: string;

  beforeEach(async () => {
    repo = await makeTempRepo();
    specPath = path.join(repo.root, SPEC_REL);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  describe('nextSpecDir', () => {
    test('allocates 001 under a missing specs root and creates the directory', async () => {
      const specsRoot = path.join(repo.root, 'specs');
      const dir = await nextSpecDir(specsRoot, 'first-feature');
      expect(dir).toBe(path.join(specsRoot, '001-first-feature'));
      expect((await fs.stat(dir)).isDirectory()).toBe(true);
    });

    test('allocates sequentially across calls', async () => {
      const specsRoot = path.join(repo.root, 'specs');
      const first = await nextSpecDir(specsRoot, 'one');
      const second = await nextSpecDir(specsRoot, 'two');
      expect(path.basename(first)).toBe('001-one');
      expect(path.basename(second)).toBe('002-two');
    });

    test('continues after the highest existing number, ignoring non-numbered dirs', async () => {
      const specsRoot = path.join(repo.root, 'specs');
      await fs.mkdir(path.join(specsRoot, '007-existing'), { recursive: true });
      await fs.mkdir(path.join(specsRoot, 'notes'), { recursive: true });
      const dir = await nextSpecDir(specsRoot, 'next');
      expect(path.basename(dir)).toBe('008-next');
    });
  });

  describe('readStatus / writeStatus', () => {
    test('reads the status value', async () => {
      await repo.writeFile(SPEC_REL, sampleSpec({ status: 'DRAFT' }));
      expect(await readStatus(specPath)).toBe('DRAFT');
    });

    test('writeStatus changes only the status line', async () => {
      const before = sampleSpec({ status: 'DRAFT' });
      await repo.writeFile(SPEC_REL, before);
      await writeStatus(specPath, 'SPECIFIED');
      const after = await repo.readFile(SPEC_REL);
      expect(after).toBe(before.replace('> Status: DRAFT', '> Status: SPECIFIED'));
      expect(await readStatus(specPath)).toBe('SPECIFIED');
    });

    test('both throw when the status line is missing', async () => {
      await repo.writeFile(SPEC_REL, '# No status here\n\n## 6. Task Breakdown\n');
      await expect(readStatus(specPath)).rejects.toThrow(/no "> Status:" line/);
      await expect(writeStatus(specPath, 'DONE')).rejects.toThrow(/no "> Status:" line/);
    });
  });

  describe('parseTasks', () => {
    test('parses id, checkbox, description, verifies, and depends_on', async () => {
      await repo.writeFile(SPEC_REL, sampleSpec());
      const tasks = await parseTasks(specPath);
      expect(tasks).toHaveLength(3);

      expect(tasks[0]).toEqual({
        number: 1,
        id: 'T1',
        checked: true,
        description: 'Project scaffold: package.json, strict tsconfig, vitest',
        verifies: ['AC1'],
        dependsOn: [],
      });
      expect(tasks[1]).toEqual({
        number: 2,
        id: 'T2',
        checked: false,
        description: 'Core module - with a hyphenated aside',
        verifies: ['AC1', 'AC2'],
        dependsOn: ['T1'],
      });
      expect(tasks[2].dependsOn).toEqual(['T1', 'T2']);
    });

    test('ignores non-task lines in section 6 and task-like lines outside it', () => {
      const decoy = '1. [ ] T9: decoy outside section 6 - verifies: AC1 - depends_on: none';
      const content = sampleSpec().replace(
        'Solve the sample problem for sample users.',
        `Solve the sample problem.\n\n${decoy}`,
      );
      const tasks = parseTasksFromContent(content);
      expect(tasks.map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);
    });

    test('throws when section 6 is missing', () => {
      expect(() => parseTasksFromContent('# Spec\n\n## 1. Mission\n\nText\n')).toThrow(
        /no "## 6\." section heading/,
      );
    });
  });

  describe('tickTask', () => {
    test('ticks exactly one checkbox and leaves the rest of the file byte-identical', async () => {
      const before = sampleSpec();
      await repo.writeFile(SPEC_REL, before);
      await tickTask(specPath, 'T2');
      const after = await repo.readFile(SPEC_REL);
      expect(after).toBe(before.replace('2. [ ] T2:', '2. [x] T2:'));
    });

    test('is idempotent for an already-checked task', async () => {
      const before = sampleSpec();
      await repo.writeFile(SPEC_REL, before);
      await tickTask(specPath, 'T1');
      expect(await repo.readFile(SPEC_REL)).toBe(before);
    });

    test('throws for an unknown task ID', async () => {
      await repo.writeFile(SPEC_REL, sampleSpec());
      await expect(tickTask(specPath, 'T99')).rejects.toThrow(/T99 not found in section 6/);
    });
  });

  describe('replaceSection6', () => {
    const NEW_BODY = [
      '1. [ ] T1: Replacement task one - verifies: AC1 - depends_on: none',
      '2. [ ] T2: Replacement task two - verifies: AC2, AC3 - depends_on: T1',
    ].join('\n');

    test('replaces section 6 without altering sections 1 to 5 or section 7', async () => {
      const before = sampleSpec();
      await repo.writeFile(SPEC_REL, before);
      await replaceSection6(specPath, NEW_BODY);
      const after = await repo.readFile(SPEC_REL);

      expect(() => assertSections1to5Unchanged(before, after)).not.toThrow();
      expect(after.slice(after.indexOf('## 7.'))).toBe(before.slice(before.indexOf('## 7.')));

      const tasks = parseTasksFromContent(after);
      expect(tasks.map((t) => t.id)).toEqual(['T1', 'T2']);
      expect(tasks[1].verifies).toEqual(['AC2', 'AC3']);
    });

    test('throws when section 6 is missing', async () => {
      await repo.writeFile(SPEC_REL, '# Spec\n\n## 1. Mission\n\nText\n');
      await expect(replaceSection6(specPath, NEW_BODY)).rejects.toThrow(
        /no "## 6\." section heading/,
      );
    });
  });

  describe('assertSections1to5Unchanged', () => {
    test('passes when only section 6 changed', () => {
      const before = sampleSpec();
      const after = sampleSpec({
        tasks: ['1. [ ] T1: Different task - verifies: AC1 - depends_on: none'],
      });
      expect(() => assertSections1to5Unchanged(before, after)).not.toThrow();
    });

    test('throws when a section 1 to 5 line is edited', () => {
      const before = sampleSpec();
      const after = before.replace('Sample thing one', 'Sneaky scope change');
      expect(() => assertSections1to5Unchanged(before, after)).toThrow(/sections 1 to 5/);
    });

    test('throws when the status line is changed', () => {
      const before = sampleSpec({ status: 'SPECIFIED' });
      const after = before.replace('> Status: SPECIFIED', '> Status: DONE');
      expect(() => assertSections1to5Unchanged(before, after)).toThrow(/sections 1 to 5/);
    });
  });

  describe('assertSection7AppendOnly', () => {
    test('passes when section 7 is unchanged', () => {
      const spec = sampleSpec();
      expect(() => assertSection7AppendOnly(spec, spec)).not.toThrow();
    });

    test('passes when new entries are appended after the prior content', () => {
      const before = sampleSpec();
      const after = `${before}- New open question from the planner.\n`;
      expect(() => assertSection7AppendOnly(before, after)).not.toThrow();
    });

    test('throws when a prior entry is edited', () => {
      const before = sampleSpec();
      const after = before.replace(
        'Is the sample open question resolved?',
        'Rewritten open question.',
      );
      expect(() => assertSection7AppendOnly(before, after)).toThrow(/append-only/);
    });

    test('throws when prior content is deleted', () => {
      const before = sampleSpec();
      const after = before.replace('- Is the sample open question resolved?\n', '');
      expect(() => assertSection7AppendOnly(before, after)).toThrow(/append-only/);
    });

    test('throws when content is inserted before the prior entries', () => {
      const before = sampleSpec();
      const after = before.replace(
        '- Is the sample open question resolved?',
        '- Inserted first.\n- Is the sample open question resolved?',
      );
      expect(() => assertSection7AppendOnly(before, after)).toThrow(/append-only/);
    });
  });

  describe('appendJournal', () => {
    test('creates the journal with a timestamped entry, creating parents', async () => {
      const journalPath = path.join(repo.root, 'specs/001-sample-feature/journal.md');
      const when = new Date('2026-01-02T03:04:05.000Z');
      await appendJournal(journalPath, 'T1 PASS: critic verified the scaffold.', when);
      const content = await fs.readFile(journalPath, 'utf8');
      expect(content).toBe(
        '## 2026-01-02T03:04:05.000Z\n\nT1 PASS: critic verified the scaffold.\n\n',
      );
    });

    test('appends never truncate: prior entries are preserved verbatim', async () => {
      const journalPath = path.join(repo.root, 'journal.md');
      await appendJournal(journalPath, 'first entry', new Date('2026-01-01T00:00:00.000Z'));
      const afterFirst = await fs.readFile(journalPath, 'utf8');

      await appendJournal(journalPath, 'second entry', new Date('2026-01-01T01:00:00.000Z'));
      const afterSecond = await fs.readFile(journalPath, 'utf8');

      expect(afterSecond.startsWith(afterFirst)).toBe(true);
      expect(afterSecond).toContain('first entry');
      expect(afterSecond).toContain('second entry');
      expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
    });
  });

  describe('findResumableSpecs', () => {
    test('returns [] when the specs root does not exist', async () => {
      const result = await findResumableSpecs(path.join(repo.root, 'specs'));
      expect(result).toEqual([]);
    });

    test('skips fully checked specs and specs without section 6', async () => {
      const done = DEFAULT_TASKS.map((line) => line.replace('[ ]', '[x]'));
      await repo.writeFile('specs/001-done/spec.md', sampleSpec({ tasks: done }));
      await repo.writeFile('specs/002-no-six/spec.md', '# Spec\n\n## 1. Mission\n\nText\n');
      const result = await findResumableSpecs(path.join(repo.root, 'specs'));
      expect(result).toEqual([]);
    });

    test('finds specs with unchecked tasks and reports the first unchecked one', async () => {
      await repo.writeFile('specs/002-in-progress/spec.md', sampleSpec());
      const done = DEFAULT_TASKS.map((line) => line.replace('[ ]', '[x]'));
      await repo.writeFile('specs/001-done/spec.md', sampleSpec({ tasks: done }));

      const result = await findResumableSpecs(path.join(repo.root, 'specs'));
      expect(result).toHaveLength(1);
      expect(result[0].specPath).toBe(path.join(repo.root, 'specs/002-in-progress/spec.md'));
      expect(result[0].firstUnchecked.id).toBe('T2');
      expect(result[0].uncheckedCount).toBe(2);
    });

    test('returns multiple resumable specs sorted by path', async () => {
      await repo.writeFile('specs/002-second/spec.md', sampleSpec());
      await repo.writeFile('specs/001-first/spec.md', sampleSpec());
      const result = await findResumableSpecs(path.join(repo.root, 'specs'));
      expect(result.map((r) => path.basename(path.dirname(r.specPath)))).toEqual([
        '001-first',
        '002-second',
      ]);
    });
  });
});
