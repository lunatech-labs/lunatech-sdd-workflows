import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  PROMPT_ROLES,
  loadPrompt,
  loadSpecTemplate,
  promptsDir,
  specTemplatePath,
} from "../src/prompts";

// Every vendored file must begin with an HTML provenance comment naming the
// upstream plugin version and the upstream file path, e.g.
// <!-- vendored from spec-swarm@0.1.0 - upstream: agents/sdd-planner.md -->
const PROVENANCE_RE =
  /^<!-- vendored from spec-swarm@\d+\.\d+\.\d+ - upstream: \S+ -->/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("vendored prompt provenance (AC13)", () => {
  const files = walk(promptsDir());

  it("prompts/ contains the four role prompts and the spec template", () => {
    const relative = files.map((f) => path.relative(promptsDir(), f)).sort();
    expect(relative).toEqual([
      "critic.md",
      "implementer.md",
      "planner.md",
      "supervisor.md",
      path.join("templates", "spec.md"),
    ]);
  });

  it.each(files.map((f) => [path.relative(promptsDir(), f), f]))(
    "%s begins with a provenance comment naming version and upstream path",
    (_rel, file) => {
      const content = readFileSync(file, "utf8");
      expect(content).toMatch(PROVENANCE_RE);
    },
  );
});

describe("prompt loader", () => {
  it("loads every role prompt", () => {
    for (const role of PROMPT_ROLES) {
      const prompt = loadPrompt(role);
      expect(prompt).toMatch(PROVENANCE_RE);
      expect(prompt.length).toBeGreaterThan(200);
    }
  });

  it("loads the spec template with the expected section headings", () => {
    const template = loadSpecTemplate();
    expect(specTemplatePath()).toBe(
      path.join(promptsDir(), "templates", "spec.md"),
    );
    expect(template).toMatch(PROVENANCE_RE);
    for (const heading of [
      "## 1. Mission / Why",
      "## 2. Outcome",
      "## 3. Scope",
      "## 4. Constraints & Decisions",
      "## 5. Acceptance Criteria",
      "## 6. Task Breakdown",
      "## 7. Open Questions",
    ]) {
      expect(template).toContain(heading);
    }
  });
});
