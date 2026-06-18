---
description: Start or resume the spec-swarm spec-driven development workflow
argument-hint: [feature description, @path/to/spec.md, or blank to resume]
---

Invoke the **spec-swarm** skill now.

User input: $ARGUMENTS

Route on the input:

- If it is a path to an existing spec/draft file — `@path/to/spec.md`, or a
  bare path ending in `.md` — begin Phase 1 (SPECIFY) in **ingest mode**: read
  that file and pre-fill the spec from it instead of interviewing from scratch.
- Else if it describes a feature, begin Phase 1 (SPECIFY) for it (interview).
- If blank, run Phase 0 (Orient): look for existing specs under `specs/` with
  unchecked tasks and offer to resume the most recent one.
