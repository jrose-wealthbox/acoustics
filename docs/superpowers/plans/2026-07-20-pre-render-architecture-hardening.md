# Pre-Renderer Architecture Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the renderer-facing simulation contract and correct stale architectural guidance before Task 11 begins, without changing acoustic calculations or measured performance behavior.

**Architecture:** Keep solver-specific field representations (`dx` for the internal point-sampled wave lattice and `resolution` for cell-binned ray maps), but expose one validated `fieldMetadata(field)` adapter with explicit sample and extent bounds for downstream consumers. Annotate worker-dispatched results with their analysis `view` and coherence semantics while preserving all existing arrays, models, and numerical values. Retain validation and synchronous/asynchronous loop duplication where extracting it would add worker load-order coupling or hot-loop abstraction risk.

**Tech Stack:** Vanilla JavaScript UMD modules, Node.js 20 built-in test runner, zero-dependency offline build.

## Global Constraints

- Work directly on `main`; do not create a branch or worktree.
- Do not begin Task 11 or create renderer/UI production code.
- Preserve the standalone `file://` and zero-network-dependency constraints.
- Preserve coherent pressure, noncoherent ray energy, unit-sum broadband crossfade, exact display lattices, immutable snapshots, and all work budgets.
- Use strict TDD for JavaScript changes and leave the generated HTML unchanged after build verification.
- Do not perform speculative performance optimization before the integrated Task 13 workflow can be profiled.

---

### Task 1: Canonical Renderer-Facing Field Metadata

**Files:**
- Modify: `tests/analysis.test.js`
- Modify: `src/analysis.js`

**Interfaces:**
- Consumes: an existing validated wave or ray field with `width`, `height`, `dx` or `resolution`, origin, and at least one numeric sample array.
- Produces: `fieldMetadata(field)` returning dimensions, spacing, `layout`, sample bounds, and rendered extent bounds without mutating the field.

- [x] **Step 1: Write the failing metadata contract test**

```js
test('field metadata gives renderers one validated geometry contract', () => {
  const field = {
    width: 2,
    height: 3,
    dx: 0.5,
    originX: -2,
    originY: 4,
    energy: new Float64Array(6),
  };
  assert.deepEqual(A.fieldMetadata(field), {
    width: 2,
    height: 3,
    cellCount: 6,
    spacing: 0.5,
    layout: 'point-sampled',
    originX: -2,
    originY: 4,
    sampleMinX: -2,
    sampleMinY: 4,
    sampleMaxX: -1.5,
    sampleMaxY: 5,
    extentMinX: -2,
    extentMinY: 4,
    extentMaxX: -1.5,
    extentMaxY: 5,
  });
  assert.equal(
    A.fieldMetadata({ ...field, dx: undefined, resolution: 0.5 }).layout,
    'cell-binned',
  );
  assert.throws(() => A.fieldMetadata({ ...field, energy: new Float64Array(5) }), /width \* height/i);
});
```

- [x] **Step 2: Run the focused test and confirm RED**

Run: `node --test --test-name-pattern='field metadata gives renderers' tests/analysis.test.js`

Expected: FAIL because `A.fieldMetadata` is not defined.

- [x] **Step 3: Export the validated metadata adapter**

```js
const fieldMetadata = field => {
  const metadata = validateField(field);
  const cellBinned = field.resolution !== undefined && field.dx === undefined;
  const sampleOffset = cellBinned ? metadata.spacing / 2 : 0;
  return {
    width: field.width,
    height: field.height,
    cellCount: metadata.cellCount,
    spacing: metadata.spacing,
    layout: cellBinned ? 'cell-binned' : 'point-sampled',
    originX: metadata.originX,
    originY: metadata.originY,
    sampleMinX: metadata.originX + sampleOffset,
    sampleMinY: metadata.originY + sampleOffset,
    sampleMaxX: metadata.originX + sampleOffset + (field.width - 1) * metadata.spacing,
    sampleMaxY: metadata.originY + sampleOffset + (field.height - 1) * metadata.spacing,
    extentMinX: metadata.originX,
    extentMinY: metadata.originY,
    extentMaxX: metadata.originX + (cellBinned ? field.width : field.width - 1) * metadata.spacing,
    extentMaxY: metadata.originY + (cellBinned ? field.height : field.height - 1) * metadata.spacing,
  };
};
```

Export `fieldMetadata` from `src/analysis.js`. Reuse the existing private validation rather than creating a second renderer-specific shape checker.
Validate every derived sample and extent bound for finiteness before returning it.

- [x] **Step 4: Run the focused analysis tests and confirm GREEN**

Run: `node --test tests/analysis.test.js`

Expected: all analysis tests pass.

---

### Task 2: Self-Describing Simulation Results

**Files:**
- Modify: `tests/worker-protocol.test.js`
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: the existing result from `solveCoherent`, hybrid broadband dispatch, or async ray coverage.
- Produces: every `runSimulation` result includes `view: 'coherent' | 'broadband' | 'paths'` and `coherent: boolean`; existing `model` values and numerical fields remain unchanged, with coherent results defaulting to `model: 'coherent-wave-pressure'` only when the solver did not supply a model.

- [x] **Step 1: Write failing result-contract assertions**

Extend worker dispatch tests to assert:

```js
assert.deepEqual(
  await W.runSimulation({ analysis: { view: 'coherent' } }, hooks, dependencies),
  { model: 'wave', view: 'coherent', coherent: true },
);
assert.equal(pathResult.view, 'paths');
assert.equal(pathResult.coherent, false);
assert.equal(broadbandResult.view, 'broadband');
assert.equal(broadbandResult.coherent, false);
```

- [x] **Step 2: Run the focused worker tests and confirm RED**

Run: `node --test tests/worker-protocol.test.js`

Expected: FAIL because dispatched results do not consistently include `view` and `coherent`.

- [x] **Step 3: Add one result annotation boundary**

```js
const annotateResult = (view, result) => ({
  ...result,
  view,
  coherent: view === 'coherent',
  model: result.model ?? RESULT_MODELS[view],
});
```

Validate the solver result as an object before annotation. Apply the adapter only in `runSimulation`; do not change direct solver APIs or numerical representations.

- [x] **Step 4: Run worker and analysis contract tests and confirm GREEN**

Run: `node --test tests/worker-protocol.test.js tests/analysis.test.js`

Expected: all focused contract tests pass.

---

### Task 3: Correct Durable Guidance Before Task 11

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-15-acoustic-room-simulator.md`
- Modify: `docs/HANDOFF.md`

**Interfaces:**
- Consumes: verified Task 10 checkpoint `2bb7353` and the approved renderer requirements.
- Produces: unambiguous Task 11 continuation guidance and translated-room-safe renderer planning.

- [x] **Step 1: Correct stale checkpoint statements**

Change `AGENTS.md` and `README.md` from “Tasks 1 through 9 / Task 10 next” to “Tasks 1 through 10 / Task 11 next.” Keep the handoff as the exact checkpoint source.

- [x] **Step 2: Replace origin-dependent Task 11 scale math**

Update the Task 11 example to derive spans from `maxX - minX` and `maxY - minY`, and translate room coordinates by `minX`/`minY`:

```js
const bounds = RoomWave.roomBounds(state.room.cells);
const roomWidth = bounds.maxX - bounds.minX;
const roomHeight = bounds.maxY - bounds.minY;
const scale = Math.min(
  (viewport.width - 80) / roomWidth,
  (viewport.height - 80) / roomHeight,
) * state.ui.zoom;
const toScreen = point => ({
  x: 40 + state.ui.pan.x + (point.x - bounds.minX) * scale,
  y: 40 + state.ui.pan.y + (point.y - bounds.minY) * scale,
});
```

Add Task 11 requirements to validate drawable viewport spans, bounded device-pixel ratio, backing-store pixel budget, zoom, pan, derived scale, and screen-coordinate finiteness before coordinate or backing-store derivation; handle an empty room explicitly; consume `RoomWave.fieldMetadata(result)` once per immutable result for field geometry; and test translated negative grid coordinates for both sources and the listening point.

- [x] **Step 3: Record intentional non-changes in the handoff**

Document that trust-boundary validators remain local, sync/async ray loops remain separately optimized and equivalence-tested, and performance refactoring is deferred until the integrated workflow can be profiled after Task 13.

---

### Task 4: Verification and Independent Review

**Files:**
- Verify all modified files.
- Do not commit `acoustic-room-simulator.html`.

**Interfaces:**
- Consumes: the complete architecture-hardening diff.
- Produces: fresh verification evidence and a reviewed checkpoint with Task 11 still next.

- [x] **Step 1: Run focused tests**

Run: `node --test tests/analysis.test.js tests/worker-protocol.test.js`

Expected: all focused tests pass.

- [x] **Step 2: Run complete verification**

Run: `npm test`

Expected: all tests pass.

Run: `npm run build`

Expected: build exits 0; restore the generated HTML to `HEAD` afterward because Task 14 owns the committed artifact.

Run: `node --check src/analysis.js && node --check src/worker.js && node --check tests/analysis.test.js && node --check tests/worker-protocol.test.js`

Expected: every syntax check exits 0.

Run: `git diff --check`

Expected: no output.

- [x] **Step 3: Inspect and independently review the complete diff**

Confirm there are no numerical algorithm changes, Task 11 production files, generated HTML changes, or new dependencies. Request an independent review focused on public-contract stability, validation, standalone loading, and scope.

- [x] **Step 4: Commit the reviewed pass on main**

```bash
git add AGENTS.md README.md docs/HANDOFF.md \
  docs/superpowers/plans/2026-07-15-acoustic-room-simulator.md \
  docs/superpowers/plans/2026-07-20-pre-render-architecture-hardening.md \
  src/analysis.js src/worker.js tests/analysis.test.js tests/worker-protocol.test.js
git commit -m "refactor: stabilize simulation result contracts"
```

Do not push unless publication is separately requested.
