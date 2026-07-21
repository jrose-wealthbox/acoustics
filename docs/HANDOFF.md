# Acoustic Room Simulator Handoff

Updated: 2026-07-20

## Checkout

- Repository: `jrose-wealthbox/acoustics`
- Branch: `main`
- Verified Task 9 code checkpoint: `cd60c0602c7f9031d468aec7afb994d898527ae7`
- Runtime: Node.js 20 or newer

`main` is the canonical development branch and contains the approved design,
implementation plan, tests, and simulator modules. No auxiliary worktree is
required; continue directly in the repository root.

## Authoritative Documents

Read these before changing code:

1. `docs/superpowers/specs/2026-07-15-acoustic-room-simulator-design.md`
2. `docs/superpowers/plans/2026-07-15-acoustic-room-simulator.md`
3. This handoff

The `.superpowers/sdd/` directory is intentionally ignored. It contains local
task briefs, review packages, reports, and the working progress ledger, so a
fresh machine should use this tracked document as the durable status source.

## Completed Scope

Tasks 1 through 9 are complete and independently reviewed:

1. Dependency-free standalone build and test scaffold
2. Topology-safe room geometry and edit strokes
3. Project state, source commands, and bounded undo/redo history
4. Source catalog, filters, directivity, and source-count limits
5. Versioned local persistence and portable JSON
6. Acoustic math, modal enumeration, grid policy, and validation
7. Coherent low-frequency wave solver
8. Five-bounce specular ray tracer
9. Energy aggregation, vertical-mode transfer, map resampling, listening-point
   sampling, and cautious diagnostic evidence

Task 9 landed in two commits:

- `be94098` adds the analysis layer.
- `cd60c06` fixes Cartesian-only coherent resampling, makes non-divisible
  resampling grids spatially honest, and strengthens raised-cosine tests.

The non-divisible resampling policy is an exact-spacing interior lattice. It
omits a trailing strip smaller than the requested display resolution rather
than clamping a terminal sample and lying about its physical coordinate.

## Verification at Handoff

The Task 9 implementation and review verified:

- `node --test tests/analysis.test.js tests/wave-solver.test.js tests/ray-tracer.test.js`
  — 49/49 passed
- `npm test` — 124/124 passed
- `npm run build` — passed
- JavaScript syntax checks — passed
- `git diff --check` — passed
- Independent Task 9 re-review — spec pass and quality pass with no findings

Run fresh verification after cloning:

```bash
npm test
npm run build
git status --short --branch
```

`npm run build` generates `acoustic-room-simulator.html`. The application is
not feature-complete at this handoff: the remaining tasks connect the solvers
to the worker, renderer, workbench, persistence workflow, and browser QA.

## Next Work

Start with Task 10 in the implementation plan. Do not skip directly to UI
integration; versioned cancellation and stale-result rejection are required to
keep expensive simulation results from overwriting newer room edits.

Remaining tasks:

10. Versioned worker protocol and chunked main-thread fallback
11. Blueprint renderer and render-plan tests
12. Workbench UI and accessible interactions
13. Presets, validation report, and integrated analysis workflow
14. Standalone, numerical, accessibility, and performance verification

Continue one task at a time with test-driven implementation and an independent
review before advancing. Preserve these project-level constraints:

- One offline HTML artifact that runs directly from `file://`
- No CDN, network, package-runtime, or web-server dependency
- Low-frequency standing waves remain phase coherent
- Ray energy remains explicitly noncoherent and is crossfaded with the wave
  model in the overlap region
- Display resolution changes resampling only, not solver accuracy
- Ceiling-height effects are an analytical uniform-height approximation, not a
  full 3D finite-difference solver
- Inputs and imported state are validated before allocations or hot loops
- Computational limits and approximation language remain visible to users

## Suggested Codex Continuation Prompt

```text
Continue the standalone acoustic-room simulator directly on main. Do not create
an auxiliary worktree unless explicitly requested.

Read docs/HANDOFF.md, the approved design spec, and the implementation plan in
full. Tasks 1-9 are complete and independently reviewed at cd60c06. Begin with
Task 10 only. Use TDD, preserve the file:// single-file constraint, validate
before allocation or hot work, run focused and full verification, and obtain an
independent review before updating this handoff and moving to another task.
```
