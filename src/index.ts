/**
 * CLI entry point: the phase state machine.
 *
 * Startup order (AC9, AC16): resolve the config, which pings Ollama before
 * anything else and fails with an actionable error when it is unreachable;
 * then the git safety check; then Phase 0 orient (resume or fresh).
 *
 * Fresh runs walk SPECIFY -> Gate 1 -> PLAN -> Gate 2 -> IMPLEMENT ->
 * PRESENT. Resumed runs jump to the right phase from the resumed spec's
 * status: SPECIFIED re-enters PLAN, PLANNED and IN PROGRESS re-enter
 * IMPLEMENT at the first unchecked task. All gates are hard stops inside the
 * phase functions; aborting at a gate ends the run with no later-phase
 * writes (AC5).
 *
 * One UI instance is injected everywhere (gates, interview answers, command
 * confirmations), so the whole flow is scriptable in tests. Expected phase
 * errors (ConfigError, SpecifyError, PlanError, AgentLoopError, OllamaError)
 * become a clean one-line message and exit code 1, never a stack trace.
 *
 * Exit codes: 0 for completed runs and clean user-driven stops (gate aborts,
 * declined git warning, drift decisions); 1 for errors and for a task
 * escalated after repeated critic FAILs.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AgentLoopError } from './agent-loop';
import { ConfigError, resolveConfig } from './config';
import { gitSafetyCheck } from './git-check';
import { OllamaError } from './ollama';
import { implement } from './phases/implement';
import { orient } from './phases/orient';
import { plan, PlanError } from './phases/plan';
import { present } from './phases/present';
import { specify, SpecifyError } from './phases/specify';
import { readStatus } from './spec-files';
import { createReadlineUI, UI } from './ui';
import { coloursEnabled, makePalette } from './colour';

export interface MainOptions {
  /** Target repo root the whole run operates on. */
  repoRoot: string;
  /** Injected terminal UI shared by every phase, gate, and tool. */
  ui: UI;
  /** Output sink for status lines and the PRESENT report. Default: console.log. */
  out?: (line: string) => void;
  /** Per-chat-call progress lines. Default: stderr. */
  onProgress?: (line: string) => void;
}

/** Where a run enters the phase machine. */
type StartPhase = 'specify' | 'plan' | 'implement';

/**
 * Run the orchestrator to completion. Returns the process exit code instead
 * of exiting, so tests can drive the full machine in-process.
 */
export async function main(options: MainOptions): Promise<number> {
  const { repoRoot, ui } = options;
  const out = options.out ?? ((line: string) => console.log(line));
  const progressPalette = makePalette(coloursEnabled(process.stderr));
  const onProgress =
    options.onProgress ??
    ((line: string) => process.stderr.write(`${progressPalette.agent(line)}\n`));

  try {
    // Ping first: resolveConfig pings Ollama as soon as the base URL is
    // known and throws ConfigError when it is unreachable (AC9).
    const config = await resolveConfig({ repoRoot, ui, warn: out });

    if (!(await gitSafetyCheck(repoRoot, (question) => ui.confirm(question)))) {
      out('Stopped: the git safety warning was declined. Nothing was changed.');
      return 0;
    }

    const oriented = await orient(repoRoot, ui);

    let startPhase: StartPhase;
    let specPath: string;
    if (oriented.mode === 'resume') {
      specPath = oriented.specPath;
      const specRelPath = path.relative(repoRoot, specPath);
      const status = await readStatus(specPath);
      if (status === 'SPECIFIED') {
        startPhase = 'plan';
      } else if (status === 'PLANNED' || status === 'IN PROGRESS') {
        startPhase = 'implement';
      } else {
        out(
          `Cannot resume ${specRelPath}: its status is "${status}", but resuming` +
            ' needs SPECIFIED, PLANNED, or IN PROGRESS. Fix the spec or start fresh.',
        );
        return 1;
      }
      out(
        `Resuming ${specRelPath} (status ${status}) from task ` +
          `${oriented.firstUnchecked.id}.`,
      );
    } else {
      startPhase = 'specify';
      const specified = await specify({
        repoRoot,
        baseUrl: config.ollamaBaseUrl,
        model: config.models.supervisor,
        ui,
        onProgress,
      });
      if (specified.outcome === 'aborted') {
        out('Aborted at Gate 1. Nothing further was written.');
        return 0;
      }
      specPath = specified.specPath;
    }

    let planPath = path.join(path.dirname(specPath), 'plan.md');
    if (startPhase !== 'implement') {
      const planned = await plan({
        repoRoot,
        specPath,
        baseUrl: config.ollamaBaseUrl,
        model: config.models.planner,
        ui,
        onProgress,
      });
      if (planned.outcome === 'aborted') {
        out('Aborted at Gate 2. Nothing further was written.');
        return 0;
      }
      planPath = planned.planPath;
    } else {
      try {
        await fs.access(planPath);
      } catch {
        out(
          `Cannot resume into IMPLEMENT: ${path.relative(repoRoot, planPath)}` +
            ' does not exist. Re-run the PLAN phase or restore the file.',
        );
        return 1;
      }
    }

    const implemented = await implement({
      repoRoot,
      specPath,
      planPath,
      baseUrl: config.ollamaBaseUrl,
      implementerModel: config.models.implementer,
      criticModel: config.models.critic,
      ui,
      onProgress,
    });

    if (implemented.outcome === 'escalated') {
      out(
        `IMPLEMENT stopped: task ${implemented.taskId} was escalated after` +
          ' repeated critic FAILs. See the critic report above.',
      );
    } else if (implemented.outcome === 'drift') {
      out(
        `IMPLEMENT stopped on task ${implemented.taskId}: drift reported by` +
          ` the ${implemented.reportedBy}, user decision "${implemented.decision}".`,
      );
    }

    // PRESENT runs whether tasks completed or the run stopped early (AC14).
    await present({ repoRoot, specPath, out });

    return implemented.outcome === 'escalated' ? 1 : 0;
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof SpecifyError ||
      error instanceof PlanError ||
      error instanceof AgentLoopError ||
      error instanceof OllamaError
    ) {
      out(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

// Interactive bootstrap: only when this file is the entry module, never on
// import (tests import main directly).
if (require.main === module) {
  main({ repoRoot: process.cwd(), ui: createReadlineUI() })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
