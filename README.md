# sdd-local

A local SDD orchestrator: runs the spec-swarm spec-driven development
workflow against locally hosted Ollama models, with no Claude Code and no
remote APIs. A terminal CLI walks you through SPECIFY, PLAN, IMPLEMENT, and
PRESENT with hard human approval gates, while role agents (supervisor,
planner, implementer, critic) work through an agentic tool loop that is
sandboxed to the target repo. Artifacts match the upstream plugin:
`specs/NNN-slug/spec.md`, `plan.md`, and an append-only `journal.md`.

The role prompts and spec template in `prompts/` are vendored from
spec-swarm 0.1.0; each file starts with a provenance comment naming its
upstream path.

## Requirements

- Node 20+ and npm
- A running [Ollama](https://ollama.com) instance (default
  `http://localhost:11434`) with at least one tool-capable model installed
  (check `ollama list`)

## Quick start

```sh
npm install

# In the target repo root, create the config:
cp /path/to/sdd-local/sdd.config.example.json sdd.config.json
# Edit it: set ollamaBaseUrl and a model per role. Any value you leave out
# is picked interactively from the models your Ollama instance reports.

# Run the orchestrator from the target repo root:
npx tsx /path/to/sdd-local/src/index.ts
```

Model names are never hardcoded: they come from `sdd.config.json` or the
interactive picker. Every shell command an agent wants to run is shown to
you and needs a per-command y/n confirmation; file tools cannot touch
anything outside the target repo root.

## Tests

```sh
npm test          # unit tests against a mocked Ollama server; no Ollama needed
npm run typecheck
```

The end-to-end smoke test (`tests/smoke.test.ts`) talks to a real local
model to validate real tool-call parsing. It is opt-in and skips (never
fails) unless all of these hold:

- `SDD_SMOKE=1` is set
- `SDD_SMOKE_MODEL` names an installed model (for example a value from
  `ollama list`)
- Ollama answers at `SDD_SMOKE_OLLAMA_URL` (default `http://localhost:11434`)

```sh
SDD_SMOKE=1 SDD_SMOKE_MODEL=<model-from-ollama-list> npx vitest run tests/smoke.test.ts
```

Real models respond slowly without streaming, so the smoke test allows a
generous timeout.
