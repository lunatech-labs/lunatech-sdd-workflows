# lunatech-sdd-workflows

A mono-repo for spec-driven development (SDD) tooling: the reusable workflow
and the first application built with it.

| Folder | What it is |
|--------|-----------|
| [`spec-swarm/`](spec-swarm/) | The workflow. A reusable, guided SDD plugin for Claude Code: a supervisor skill that interviews you into a spec, then dispatches a planner, implementer, and critic to deliver it task by task behind human approval gates. |
| [`sdd-local/`](sdd-local/) | An application built with the workflow. A local SDD orchestrator that runs the same SPECIFY, PLAN, IMPLEMENT, PRESENT loop against locally hosted models, with no Claude Code and no remote APIs. You assign a model per role and it runs at zero token cost. Functional but a work in progress (see below). |

## How the two relate

`spec-swarm` is the tool; `sdd-local` is an artifact that tool produced. The
role prompts and spec template in `sdd-local/prompts/` are vendored from
spec-swarm, each carrying a provenance comment naming its upstream path. The
two are kept together so the relationship stays legible, but they are
independent at runtime: `sdd-local` does not import `spec-swarm`, and the
plugin stays usable on its own.

The two flavours differ mainly in where the model runs. The plugin uses
whatever model your Claude Code session is on; it is nicer to use and gets
better results. `sdd-local` lets you assign a different local model per role
and runs at zero token cost, with more human-in-the-loop since the smaller
models need it.

If an artifact like `sdd-local` comes out rough, that is about the build, not
a reason to skip SDD on the next piece of work. For when SDD earns its
ceremony versus when to just edit directly, see
[When to use the SDD pipeline vs. make changes directly](spec-swarm/docs/guidelines-sdd-vs-direct-edits.md).

## Status

`spec-swarm` (the plugin) is the polished path and the one to start with.

`sdd-local` is functional but a work in progress. It currently uses Ollama;
planned directions include other local backends, hybrid local plus
subscription models (different models perform differently per task), and
automatic fallback to local when a subscription limit is reached. Feedback
and contributions are welcome, especially on the local flavour.

## Getting started

Each folder is self-contained with its own README and setup:

- Workflow plugin: [`spec-swarm/README.md`](spec-swarm/README.md)
- Local orchestrator: [`sdd-local/README.md`](sdd-local/README.md)
