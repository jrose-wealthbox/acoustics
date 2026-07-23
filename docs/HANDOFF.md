# Acoustic Room Simulator Handoff

Updated: 2026-07-22

## Checkout

- Repository: `jrose-wealthbox/acoustics`
- Branch: `main`
- Verified Task 11 checkpoint: the `main` commit containing this handoff
- Runtime: Node.js 20 or newer

`main` is the canonical development branch and contains the approved design,
implementation plan, tests, and simulator modules. No auxiliary worktree is
required; continue directly in the repository root.

## Authoritative Documents

Read these before changing code:

1. `AGENTS.md`
2. `README.md`
3. This handoff
4. `docs/superpowers/specs/2026-07-15-acoustic-room-simulator-design.md`
5. The next unfinished task in
   `docs/superpowers/plans/2026-07-15-acoustic-room-simulator.md`

The `.superpowers/sdd/` directory is intentionally ignored. It contains local
task briefs, review packages, reports, and the working progress ledger, so a
fresh machine should use this tracked document as the durable status source.

## Completed Scope

Tasks 1 through 11 are complete and independently reviewed:

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
10. Versioned worker protocol, stale-result rejection, cancellation, debounced
    scheduling, Blob-worker lifecycle, and bounded yielding main-thread fallback
11. Deterministic blueprint render plans, layered Canvas drawing, field
    palettes and contours, reflection paths, source/listening-point hit targets,
    and visibly flagged off-room sources

Task 9 landed in two commits:

- `be94098` adds the analysis layer.
- `cd60c06` fixes Cartesian-only coherent resampling, makes non-divisible
  resampling grids spatially honest, and strengthens raised-cosine tests.

The non-divisible resampling policy is an exact-spacing interior lattice. It
omits a trailing strip smaller than the requested display resolution rather
than clamping a terminal sample and lying about its physical coordinate.

Task 10 added a monotonically increasing solve protocol shared by the inline
Blob worker and main-thread fallback. Scheduling a newer snapshot reserves its
version immediately, cancels active work, and rejects any older result during
the debounce window. Worker construction and runtime transport failures switch
to the documented yielding fallback without allowing stale completion.

All three analysis views now have worker/fallback dispatch. Coherent solves use
the cancellable wave solver. Reflection and broadband ray work preflight the
global intersection/deposit budgets once, prepare geometry once, and yield
inside map, trace, and energy-deposition loops. Broadband uses exact
one-third-octave centers from 20 Hz, resamples only after the wave calculation,
and applies the Task 9 unit-sum raised-cosine wave/ray overlap.

Before Task 11, a bounded architecture review stabilized the renderer-facing
boundary without changing solver algorithms. Worker-dispatched results now
self-identify their analysis view and whether the result is coherent, while
`fieldMetadata(result)` supplies one validated geometry contract with explicit
point-sampled versus cell-binned layout, sample bounds, and rendered extents.
The Task 11 plan now handles rooms whose grid origin is translated or negative
instead of assuming `(0, 0)`.

Repeated validators remain local to their module trust boundaries so the
standalone worker does not acquire hidden load-order coupling. The synchronous
and yielding ray loops also remain separate and equivalence-tested rather than
introducing abstraction overhead into a bounded hot path. Broader loop
refactoring and performance optimization remain deferred until the integrated
Task 13 workflow can be profiled with representative browser interactions.

Task 11 added a renderer boundary that consumes immutable project snapshots
and self-identifying analysis results without mutating either. Render plans use
CSS-pixel coordinates while separately bounding Canvas backing dimensions and
total pixels. Room geometry, one-meter grid lines, walls, field rasters, 3 dB
coherent contours, reflection paths, selected directional cones, source icons,
the listening-point crosshair, and semantic legends are drawn in a fixed layer
order.

Field validation and normalized display preparation are cached once per result
object. Point-sampled wave fields and cell-binned ray fields retain their
different spatial semantics. Contour generation, field samples, path counts,
path points, room spans, viewport transforms, and backing allocations are
explicitly bounded before Canvas work. Results whose view or coherence metadata
does not match current analysis are rejected atomically.

Sources left outside the room after an edit remain in the render plan and keep
their hit targets. They receive a dashed warning ring and X in addition to color
so invalid placement is not communicated by color alone. Task 11 intentionally
does not add DOM workbench controls or connect renderer events to project state;
that is Task 12.

## Verification at Handoff

The Task 10 implementation and review verified:

- `node --test tests/worker-protocol.test.js tests/wave-solver.test.js tests/ray-tracer.test.js tests/analysis.test.js`
  — 74/74 passed
- `npm test` — 149/149 passed
- `npm run build` — passed
- JavaScript syntax checks for every changed JavaScript file — passed
- `git diff --check` — passed
- Independent Task 10 review and re-review — initial stale-debounce,
  incomplete-dispatch, repeated-ray-work, band-spacing, and cancellation-error
  findings plus a preflight-token validation finding fixed; final re-review
  found no Critical or Important issues

The pre-Task-11 architecture-hardening pass verified:

- `node --test tests/analysis.test.js tests/worker-protocol.test.js` — 40/40 passed
- `npm test` — 150/150 passed
- `npm run build` — passed; the Task 14-owned generated HTML was restored
- JavaScript syntax checks for every changed JavaScript file — passed
- `git diff --check` — passed
- Independent review and two re-review rounds — field-layout and renderer-plan
  derived-bound findings fixed; final re-review found no Critical or Important
  issues

The Task 11 implementation and review verified:

- `node --test tests/renderer.test.js tests/analysis.test.js tests/build.test.js`
  — 33/33 passed
- `npm test` — 164/164 passed
- `npm run build` — passed and regenerated the standalone HTML from current
  renderer source
- JavaScript syntax checks for every changed JavaScript file — passed
- `git diff --check` — passed
- Independent review and re-review — coherence metadata, derived field/path
  coordinates, forged backing dimensions, stale generated output, and
  non-color off-room-source warnings were checked; final review found no
  Critical or Important issues

Run fresh verification after cloning:

```bash
npm test
npm run build
git status --short --branch
```

`npm run build` generates `acoustic-room-simulator.html`. The application is
not feature-complete at this handoff: the remaining tasks connect the completed
simulation orchestration and renderer to the workbench, integrated persistence
workflow, and browser QA.

## Next Work

Start with Task 12 in the implementation plan. Do not begin integrated presets
or validation-report work before the workbench UI and accessible interactions
pass focused review.

Remaining tasks:

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

Read AGENTS.md, README.md, docs/HANDOFF.md, the approved design spec, and the
Task 12 section of the implementation plan in full. Tasks 1-11 are complete and
independently reviewed. Begin with Task 12 only. Use TDD, preserve the file://
single-file constraint, validate before allocation or hot work, run focused and
full verification, and obtain an independent review before updating this
handoff and moving to another task.
```
