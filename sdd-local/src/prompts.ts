import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Vendored prompt loader.
 *
 * Prompts live in the `prompts/` directory at the package root, vendored
 * from the spec-swarm plugin (see the provenance comment at the top of each
 * file). They are resolved relative to this package, never relative to the
 * target repo the orchestrator is run from.
 */

export type PromptRole = "supervisor" | "planner" | "implementer" | "critic";

export const PROMPT_ROLES: readonly PromptRole[] = [
  "supervisor",
  "planner",
  "implementer",
  "critic",
];

/**
 * Absolute path to the vendored prompts directory. Works both when running
 * from source via tsx (src/prompts.ts) and when compiled (dist/prompts.js):
 * in both cases `prompts/` is one level up, at the package root.
 */
export function promptsDir(): string {
  return path.resolve(__dirname, "..", "prompts");
}

/** Load the vendored system prompt for one role. */
export function loadPrompt(role: PromptRole): string {
  return readFileSync(path.join(promptsDir(), `${role}.md`), "utf8");
}

/** Absolute path to the vendored spec template. */
export function specTemplatePath(): string {
  return path.join(promptsDir(), "templates", "spec.md");
}

/** Load the vendored spec template content. */
export function loadSpecTemplate(): string {
  return readFileSync(specTemplatePath(), "utf8");
}
