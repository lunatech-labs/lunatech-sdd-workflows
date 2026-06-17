# Feature Spec: [Feature Name]

> Status: DRAFT | SPECIFIED | PLANNED | IN PROGRESS | DONE
> Spec folder: specs/NNN-feature-slug/

## 1. Mission / Why

What problem does this solve, and for whom? One or two sentences.
Why is it worth building now?

## 2. Outcome

What does "done" look like in plain language?
A user can [do X] and see [result Y].

## 3. Scope

### In scope

- [Thing this feature WILL do]
- [Thing this feature WILL do]

### Out of scope

- [Thing this feature will NOT do — list these explicitly]
- [Thing this feature will NOT do]

## 4. Constraints & Decisions

- Language / framework: [e.g. Python, React]
- Must use / must not use: [existing libraries, patterns, APIs]
- Prior decisions the agent should respect: [e.g. auth handled by existing module]

## 5. Acceptance Criteria (how you'll verify it)

Write these as testable statements. If you can't test it, rewrite it.

- [ ] AC1: Given [input], when [action], then [expected result]
- [ ] AC2 (edge case): when [unusual input], the system [does X]
- [ ] AC3 (errors): when [failure], the system [handles it how]

## 6. Task Breakdown

<!-- Filled in by sdd-planner, approved by the user at Gate 2.
     Each task: testable in isolation, ~30–60 min of agent work,
     maps to at least one acceptance criterion. -->

1. [ ] T1: [task] — verifies: AC1 — depends_on: none
2. [ ] T2: [task] — verifies: AC1, AC2 — depends_on: T1
3. [ ] T3: [task] — verifies: AC3 — depends_on: T1

## 7. Open Questions

- [Anything unsure — flagged rather than guessed. Resolve before the task
  that depends on it.]
