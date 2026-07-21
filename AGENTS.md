# Repository Instructions

## Purpose and Current State

This repository builds a standalone acoustic-room simulator for hobbyist
audiophiles and acoustical engineers exploring room geometry and loudspeaker
placement. The final deliverable is one `acoustic-room-simulator.html` file
that runs directly from `file://` without a server or network access.

Tasks 1 through 10 are complete. Task 11 is the next unfinished task. The app is
not feature-complete until Tasks 11 through 14 in the implementation plan are
finished and verified.

## Required Reading and Sources of Truth

Before changing code, read these in order:

1. `AGENTS.md`
2. `docs/HANDOFF.md` for the current checkpoint and next task
3. `docs/superpowers/specs/2026-07-15-acoustic-room-simulator-design.md`
   for approved product and physics behavior
4. The current task in
   `docs/superpowers/plans/2026-07-15-acoustic-room-simulator.md`

Do not duplicate or casually reinterpret these documents. If they conflict,
stop and resolve the contradiction explicitly. Update `docs/HANDOFF.md` after
finishing and reviewing a task so another machine can resume from Git alone.

## Working Model

- Work directly on `main`. Do not create a branch or worktree unless the user
  explicitly requests one.
- Complete one numbered plan task at a time. Do not begin the next task until
  the current task passes focused verification and review.
- Preserve existing user changes and keep commits scoped to the current task.
- Follow existing vanilla JavaScript and Node test patterns. Do not add runtime
  packages, CDNs, remote fonts, analytics, or network dependencies.
- Treat `src/` as source and `acoustic-room-simulator.html` as generated output.
  The approved plan reserves the final rebuilt artifact for Task 14; do not
  commit intermediate generated changes unless the current task says to.
- Keep `.superpowers/` artifacts local and ignored. Durable status belongs in
  `docs/HANDOFF.md`.

## Engineering Expectations

- Push back on technically weak ideas. Explain the alternative and its
  tradeoffs instead of silently implementing a misleading shortcut.
- Assume the maintainer is an experienced software developer. Explain relevant
  internals and non-obvious acoustic or numerical reasoning without explaining
  basic JavaScript operations.
- Use test-driven development for features and fixes: reproduce failure first,
  implement the smallest robust behavior, then run broader verification.
- Validate types, finiteness, dimensions, bounds, and work budgets before large
  allocations or nested hot loops. A finite input can still derive an unsafe
  or infinite result.
- Preserve caller-owned state. Reducers, solvers, renderers, persistence, and
  diagnostics should consume immutable snapshots or return new values.
- Reject invalid state atomically with actionable errors. Never silently move,
  delete, coarsen, or partially accept project data.
- Keep performance-critical work explicitly bounded and cancellation-aware.
- Avoid overclaiming accuracy. UI and diagnostic copy must distinguish
  predictions and likely contributors from measurements or unique causes.

Add inline comments only when they explain why code is:

- a necessary workaround for a bug or platform limitation;
- unconventional, including why a conventional approach was rejected;
- driven by non-obvious acoustics domain knowledge;
- performance-critical on a hot path; or
- brittle for a non-obvious numerical or browser reason.

Do not add comments that narrate basic operations, restate identifiers, or
compensate for unclear code that should instead be simplified.

## Acoustic and Numerical Invariants

These constraints must survive refactors and integration:

- Low-frequency wave results combine source pressure coherently in Cartesian
  complex form so standing-wave peaks, nulls, phase, polarity, and delay remain
  meaningful.
- High-frequency ray results are noncoherent relative energy. Do not label them
  as phase-accurate interference.
- Broadband aggregation combines energy over logarithmic bands and uses a
  unit-sum overlap crossfade; it does not sum unrelated frequencies as pressure
  or average decibel values directly.
- The floor-plan solver is two-dimensional. Ceiling-height behavior is an
  analytical uniform-height vertical-mode approximation, not a full 3D solve.
- Display resolution changes resampling only. It must not silently alter the
  wave solver's internal accuracy or declared reliable-frequency limit.
- A non-divisible display span uses the documented exact-spacing interior
  lattice. Do not clamp a terminal sample while reporting a false coordinate.
- Wall absorption is an energy coefficient; reflection amplitude is derived
  consistently from it.
- Computational limits, solver fidelity, elapsed work, and approximation
  boundaries must remain visible to the user.

Detailed formulas, ranges, defaults, and interaction behavior remain
authoritative in the approved design specification.

## Verification and Completion

For each task:

1. Run the focused tests named by the plan plus regressions for discovered edge
   cases.
2. Run `npm test`.
3. Run `npm run build` when the task affects packaging or integration.
4. Run syntax checks for changed JavaScript and `git diff --check`.
5. Inspect `git status --short` and the complete task diff before committing.
6. Obtain an independent review when agent tooling is available; fix important
   findings and re-review before marking the task complete.
7. Update `docs/HANDOFF.md` with the verified checkpoint, remaining task, and
   any decision a fresh checkout cannot infer from source and tests.

Do not claim completion from historical results. Report the exact fresh checks
run in the current checkout. Commit intentionally; push only when the user has
requested publication or cross-machine handoff.

## Current Documentation Lookup

When answering or implementing against a library, framework, SDK, API, CLI, or
cloud service, consult current primary documentation through Context7 when it
is available. This is unnecessary for project-local business logic,
refactoring, code review, or standalone scripts that do not depend on an
external API.
