/**
 * Phase 0 orient: resume detection (AC10).
 *
 * Scans `specs/` in the target repo for spec.md files that still have
 * unchecked section 6 tasks. When any are found the user is offered the
 * choice to resume (returning the spec path and its first unchecked task)
 * or start fresh. With no resumable specs the phase returns fresh without
 * asking anything.
 */
import * as path from 'node:path';
import { findResumableSpecs, SpecTask } from '../spec-files';
import type { UI } from '../ui';

export type OrientResult =
  | { mode: 'fresh' }
  | { mode: 'resume'; specPath: string; firstUnchecked: SpecTask };

/** Option label offered alongside resumable specs when several exist. */
export const START_FRESH = 'Start fresh (new spec)';

function describe(repoRoot: string, specPath: string, taskId: string, unchecked: number): string {
  const rel = path.relative(repoRoot, specPath);
  return `${rel} (${unchecked} unchecked task(s), next: ${taskId})`;
}

/**
 * Run Phase 0 against `repoRoot` using the injected UI. Returns how the run
 * should start: fresh, or resuming a specific spec from its first unchecked
 * task.
 */
export async function orient(repoRoot: string, ui: UI): Promise<OrientResult> {
  const resumable = await findResumableSpecs(path.join(repoRoot, 'specs'));
  if (resumable.length === 0) {
    return { mode: 'fresh' };
  }

  if (resumable.length === 1) {
    const spec = resumable[0];
    const label = describe(repoRoot, spec.specPath, spec.firstUnchecked.id, spec.uncheckedCount);
    const resume = await ui.confirm(`Found a spec in progress: ${label}. Resume it?`);
    if (!resume) return { mode: 'fresh' };
    return { mode: 'resume', specPath: spec.specPath, firstUnchecked: spec.firstUnchecked };
  }

  const labels = resumable.map((spec) =>
    describe(repoRoot, spec.specPath, spec.firstUnchecked.id, spec.uncheckedCount),
  );
  const choice = await ui.select('Found specs in progress. Resume one or start fresh?', [
    ...labels,
    START_FRESH,
  ]);
  const index = labels.indexOf(choice);
  if (index === -1) {
    return { mode: 'fresh' };
  }
  const spec = resumable[index];
  return { mode: 'resume', specPath: spec.specPath, firstUnchecked: spec.firstUnchecked };
}
