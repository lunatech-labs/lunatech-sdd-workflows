# When to use the SDD pipeline vs. make changes directly

A decision guide for SDD-driven development. The point of SDD is a durable
**contract** (the spec) plus **independent verification** (the critic). That
machinery is worth real ceremony on some work and is pure overhead on other
work. Choose deliberately.

First, keep two things distinct:

- **The SDD tool** — the spec-swarm workflow driven by strong (premium) models. This is reliable; use it freely on the right *kind* of work.
- **A pipeline artifact** — something the SDD tool *built*. If an artifact comes out rough, that's about the build, not a reason to skip SDD on the next piece of work.

## Use the SDD pipeline when

- The work is **net-new** or a **substantial, well-bounded** change — a feature, a module, a service.
- You can write **real, testable acceptance criteria** — given/when/then statements a critic can independently check. SDD's value is the critic failing work against the spec; no testable AC, little value.
- The work is **verifiable by tests the critic can run** (logic, endpoints, data transforms).
- It will be **handed off, paused, or resumed** — the spec + journal carry context across sessions, models, and people.
- You want a **durable record** of scope, out-of-scope, decisions, and drift.

## Make the change directly when

- It's **small, surgical, and well-understood** — a few files, an obvious diff. The spec/plan/gate ceremony costs more than the change.
- It touches the **interactive / IO / presentation layer** that an agent loop can't meaningfully verify anyway (terminal input, colours, prompts). You'll be testing it by hand regardless.
- It's **plumbing or a prerequisite of the pipeline itself** — fixing the floor the pipeline stands on. (Bootstrapping: don't route a fix *through* the very thing it's fixing.)
- It's an **exploratory spike** where you don't yet know the shape of the answer — spec it *after* you've learned, not before.
- It's an **emergency hotfix**.

## Rule of thumb

> Use SDD when the cost of a written contract and independent verification is
> repaid by the **size, novelty, durability, or verifiability** of the work.
> For a small, interactive, or self-referential change, edit directly — then,
> if the learning is worth keeping, fold it back into a spec or the backlog.

"Directly" is not "undisciplined": still write tests where they make sense, and
journal a decision if it carries weight. The difference is skipping the spec /
plan / gate loop, not skipping rigor.

## Worked examples

| Change | Route | Why |
|--------|-------|-----|
| Fix interactive input paste/submit + colour the input blocks | **Direct** | Small, interactive, can't be verified through an agent loop; it's the pipeline's own input floor. |
| Terminal *bracketed-paste* support (paste-anything, Enter submits) | **SDD** (later) | A larger, well-bounded feature with checkable behavior — worth a spec once scoped. |
| Add a spec-critic / semantic spec-lint | **SDD** | Net-new, testable, durable; exactly the contract-plus-verification sweet spot. |
| Containment-guard salvage + planner section-edit tool | **SDD** | Bounded feature with clear acceptance criteria the critic can run. |
| One-line copy fix in a prompt | **Direct** | Trivial; a gate would be theatre. |
