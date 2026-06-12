/**
 * Config loading and interactive model selection.
 *
 * `sdd.config.json` at the target repo root defines the Ollama base URL and
 * one model per role:
 *
 *   {
 *     "ollamaBaseUrl": "http://localhost:11434",
 *     "models": {
 *       "supervisor": "...", "planner": "...",
 *       "implementer": "...", "critic": "..."
 *     }
 *   }
 *
 * No model name is ever hardcoded in this package (AC8): any missing value
 * is filled interactively, with the choices fetched from the local Ollama
 * instance via GET /api/tags.
 *
 * Startup order (AC9): `resolveConfig` pings Ollama as soon as the base URL
 * is known, before any model selection, and throws a ConfigError with an
 * actionable message when it is unreachable. The CLI entry (T14) only needs
 * to call `resolveConfig` before the interview and surface ConfigError as a
 * clean exit.
 *
 * The resolved config is returned to the caller and never persisted
 * silently: when anything was filled interactively, the user is offered a
 * one-time confirm to write the completed config back to sdd.config.json.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { listModels, ping, showCapabilities } from './ollama';
import type { UI } from './ui';

export const CONFIG_FILE_NAME = 'sdd.config.json';

/** Suggested base URL when the user leaves the prompt empty. This is the
 * standard local Ollama address, not a model name. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

export const ROLES = ['supervisor', 'planner', 'implementer', 'critic'] as const;
export type Role = (typeof ROLES)[number];

/** Fully resolved configuration: every role has a model. */
export interface SddConfig {
  ollamaBaseUrl: string;
  models: Record<Role, string>;
}

/** What a config file may legally contain: any subset of the values. */
export interface PartialSddConfig {
  ollamaBaseUrl?: string;
  models: Partial<Record<Role, string>>;
}

/** Error for an unusable config file or an unreachable/empty Ollama. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ResolveConfigOptions {
  /** Target repo root: where sdd.config.json is read from and written to. */
  repoRoot: string;
  /** Injected terminal UI for prompts; tests pass a scripted fake. */
  ui: UI;
  /** Sink for best-effort capability warnings. Default: console.warn. */
  warn?: (message: string) => void;
}

/**
 * Read and validate sdd.config.json from the repo root. A missing file is
 * not an error (returns an empty partial config); a malformed one is, with
 * a message naming the file and the problem.
 */
export async function loadConfigFile(repoRoot: string): Promise<PartialSddConfig> {
  const file = path.join(repoRoot, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { models: {} };
    }
    throw new ConfigError(`Could not read ${file}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`${file} must contain a JSON object.`);
  }

  const config: PartialSddConfig = { models: {} };

  if ('ollamaBaseUrl' in parsed) {
    const url = parsed.ollamaBaseUrl;
    if (typeof url !== 'string' || url.trim() === '') {
      throw new ConfigError(`${file}: "ollamaBaseUrl" must be a non-empty string.`);
    }
    config.ollamaBaseUrl = url.trim();
  }

  if ('models' in parsed) {
    const models = parsed.models;
    if (!isPlainObject(models)) {
      throw new ConfigError(`${file}: "models" must be an object mapping role to model.`);
    }
    for (const [key, value] of Object.entries(models)) {
      if (!(ROLES as readonly string[]).includes(key)) {
        throw new ConfigError(
          `${file}: unknown role "${key}" in "models". Valid roles: ${ROLES.join(', ')}.`,
        );
      }
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigError(`${file}: "models.${key}" must be a non-empty string.`);
      }
      config.models[key as Role] = value.trim();
    }
  }

  return config;
}

/**
 * Produce a complete SddConfig for this run:
 *
 *   1. Load sdd.config.json (missing file is fine, malformed is an error).
 *   2. Prompt for the base URL when absent.
 *   3. Ping Ollama; throw ConfigError with an actionable message when
 *      unreachable, before any model selection or interview (AC9).
 *   4. For each role without a model, select interactively from the models
 *      installed on the Ollama instance (AC8).
 *   5. Best-effort tool-capability warning per distinct model, telling
 *      "no tool support" apart from "could not verify".
 *   6. If anything was filled interactively, offer (confirm) to write the
 *      completed config back; never write without confirmation.
 */
export async function resolveConfig(options: ResolveConfigOptions): Promise<SddConfig> {
  const { repoRoot, ui } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const fromFile = await loadConfigFile(repoRoot);
  let filledInteractively = false;

  let ollamaBaseUrl = fromFile.ollamaBaseUrl;
  if (ollamaBaseUrl === undefined) {
    filledInteractively = true;
    const answer = await ui.ask(
      `Ollama base URL (empty for ${DEFAULT_OLLAMA_BASE_URL}):`,
    );
    ollamaBaseUrl = answer === '' ? DEFAULT_OLLAMA_BASE_URL : answer;
  }

  // Reachability gate: fail here, before any selection or interview.
  const reachable = await ping(ollamaBaseUrl);
  if (!reachable.ok) {
    throw new ConfigError(reachable.error);
  }

  const models: Partial<Record<Role, string>> = { ...fromFile.models };
  let installed: string[] | undefined;
  for (const role of ROLES) {
    if (models[role] !== undefined) {
      continue;
    }
    filledInteractively = true;
    if (installed === undefined) {
      installed = await listModels(ollamaBaseUrl);
      if (installed.length === 0) {
        throw new ConfigError(
          `No models are installed on Ollama at ${ollamaBaseUrl}.` +
            ` Pull one with "ollama pull <model>" and run again.`,
        );
      }
    }
    models[role] = await ui.select(`Choose a model for the ${role} role`, installed);
  }

  const config: SddConfig = {
    ollamaBaseUrl,
    models: models as Record<Role, string>,
  };

  await warnAboutToolSupport(config, warn);

  if (filledInteractively) {
    const save = await ui.confirm(
      `Save this configuration to ${CONFIG_FILE_NAME} for next time?`,
    );
    if (save) {
      await fs.writeFile(
        path.join(repoRoot, CONFIG_FILE_NAME),
        `${JSON.stringify(config, null, 2)}\n`,
        'utf8',
      );
    }
  }

  return config;
}

/**
 * Best-effort tool-capability check per distinct model. Three outcomes:
 * capabilities include "tools" (silent), capabilities reported without
 * "tools" (warn: no tool support), capabilities unavailable, whether the
 * field is missing or /api/show failed (warn: could not verify).
 */
async function warnAboutToolSupport(
  config: SddConfig,
  warn: (message: string) => void,
): Promise<void> {
  const checked = new Set<string>();
  for (const role of ROLES) {
    const model = config.models[role];
    if (checked.has(model)) {
      continue;
    }
    checked.add(model);

    let capabilities: string[] | undefined;
    try {
      capabilities = await showCapabilities(config.ollamaBaseUrl, model);
    } catch {
      capabilities = undefined;
    }

    if (capabilities === undefined) {
      warn(
        `Could not verify tool-calling support for model "${model}":` +
          ` the Ollama server did not report its capabilities. Proceeding anyway.`,
      );
    } else if (!capabilities.includes('tools')) {
      warn(
        `Model "${model}" does not advertise tool-calling support;` +
          ` agent dispatches with it may fail.`,
      );
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
