# Acoustic Room Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested, dependency-free acoustic room-design workbench that compiles into one standalone HTML file and visualizes low-frequency standing waves, source interference, broadband coverage, and reflection paths.

**Architecture:** Keep numerical physics, room topology, persistence, rendering, and interaction logic in focused UMD-style source modules that work in Node tests and attach to `globalThis.RoomWave` in the browser. A zero-dependency Node build script inlines the CSS, JavaScript modules, and worker source into `acoustic-room-simulator.html`; the generated file performs all computation locally and uses a Blob-backed Web Worker with a chunked main-thread fallback.

**Tech Stack:** HTML5, CSS, ES2022 JavaScript, Canvas 2D, Web Workers, Node.js 26 built-in `node:test`, no runtime or development dependencies.

## Global Constraints

- The deliverable is one `acoustic-room-simulator.html` file that runs directly from `file://` without a web server or network access.
- All HTML, CSS, JavaScript, worker source, icons, and default data are inline in the deliverable.
- The default room is 10 × 7 × 2.5 m over a 1 × 1 m blueprint grid.
- Display resolution choices are 0.1, 0.25, 0.5, and 1 m.
- The normal coherent-frequency range is 20–200 Hz; advanced mode may extend to the current conservative reliable wave limit.
- The room supports up to 10 directional speakers and 4 subwoofers.
- Directional speakers rotate in 45° increments; source gain is −12 to +6 dB, delay is 0–20 ms, and polarity is normal or inverted.
- Ceiling height is 2–10 m in 0.5 m increments; source and listening heights use 0.1 m increments.
- The first version uses uniform ceiling height and one frequency-independent global wall absorption coefficient, default `α = 0.15`.
- Coherent results use relative pressure and phase; broadband results use relative logarithmically weighted energy; neither claims calibrated absolute SPL.
- Ray-derived output above the wave solver's reliable band is labeled coverage/reflection estimation, not phase-accurate interference.
- No external packages, CDNs, font downloads, web APIs, or network requests.
- Follow the approved design in `docs/superpowers/specs/2026-07-15-acoustic-room-simulator-design.md`.

## File Structure

- `package.json` — dependency-free test/build scripts and supported Node version.
- `scripts/build.mjs` — deterministic inliner that produces the standalone HTML and embedded worker source.
- `src/index.html` — accessible workbench markup with build placeholders.
- `src/styles.css` — blueprint visual system, responsive layout, focus, and reduced-motion rules.
- `src/namespace.js` — shared UMD registration helper and constants.
- `src/geometry.js` — cell topology, bounds, connectivity, hole detection, strokes, and wall extraction.
- `src/state.js` — default project state, reducer, source limits, and bounded undo/redo history.
- `src/sources.js` — source catalog, response filters, directivity, gain, delay, and polarity math.
- `src/persistence.js` — schema validation, local preset/project storage, and JSON import/export.
- `src/acoustics.js` — speed/wavelength math, solver-grid policy, rectangular modes, and reflection loss.
- `src/wave-solver.js` — low-frequency finite-difference calculations and cancellation/progress hooks.
- `src/ray-tracer.js` — direct rays, wall intersections, specular reflection, five-bounce paths, and coverage accumulation.
- `src/analysis.js` — broadband aggregation, vertical-mode approximation, map resampling, listening-point response, and diagnostics.
- `src/worker.js` — versioned worker message protocol around numerical modules.
- `src/controller.js` — worker lifecycle, stale-result rejection, debounce, cancellation, and chunked fallback.
- `src/renderer.js` — Canvas 2D blueprint, fields, legends, sources, listening point, and paths.
- `src/app.js` — DOM binding, drag/drop, room edit mode, keyboard controls, inspectors, persistence, and validation report.
- `tests/*.test.js` — Node unit, numerical, protocol, build, and integration tests.
- `tests/manual-checklist.md` — browser and accessibility verification record.
- `acoustic-room-simulator.html` — generated standalone deliverable committed after verification.

---

### Task 1: Dependency-free build and test scaffold

**Files:**
- Create: `package.json`
- Create: `scripts/build.mjs`
- Create: `src/index.html`
- Create: `src/styles.css`
- Create: `src/namespace.js`
- Create: `tests/build.test.js`
- Create: `tests/manual-checklist.md`

**Interfaces:**
- Produces: `npm test`, `npm run build`, `globalThis.RoomWave`, and generated `acoustic-room-simulator.html`.
- Consumes: no earlier task.

- [ ] **Step 1: Write the failing standalone-build test**

```js
// tests/build.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

test('build creates one offline HTML file with inline CSS and JavaScript', () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  const html = fs.readFileSync('acoustic-room-simulator.html', 'utf8');

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<style>[\s\S]+<\/style>/);
  assert.match(html, /<script>[\s\S]+<\/script>/);
  assert.doesNotMatch(html, /<(script|link)[^>]+(?:src|href)=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});
```

- [ ] **Step 2: Run the build test and verify the missing build fails**

Run: `node --test tests/build.test.js`

Expected: FAIL because `scripts/build.mjs` does not exist.

- [ ] **Step 3: Add the package scripts, HTML placeholders, namespace, and deterministic inliner**

```json
{
  "name": "room-wave-acoustic-simulator",
  "private": true,
  "scripts": {
    "build": "node scripts/build.mjs",
    "test": "node --test tests/*.test.js"
  },
  "engines": { "node": ">=20" }
}
```

```js
// scripts/build.mjs
import fs from 'node:fs';

const mainModules = ['namespace', 'geometry', 'state', 'sources', 'persistence', 'acoustics', 'wave-solver', 'ray-tracer', 'analysis', 'worker', 'controller', 'renderer', 'app'];
const workerModules = ['namespace', 'geometry', 'sources', 'acoustics', 'wave-solver', 'ray-tracer', 'analysis', 'worker'];
const read = path => fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
const mainSource = mainModules.map(name => read(`src/${name}.js`)).join('\n');
const workerSource = workerModules.map(name => read(`src/${name}.js`)).join('\n') + '\nRoomWave.installWorker(globalThis);';
const template = read('src/index.html');
const html = template
  .replace('/*__INLINE_STYLES__*/', read('src/styles.css'))
  .replace('/*__WORKER_BOOTSTRAP__*/', `globalThis.__ROOM_WAVE_WORKER_SOURCE__ = ${JSON.stringify(workerSource)};`)
  .replace('/*__INLINE_SCRIPTS__*/', mainSource);

fs.writeFileSync('acoustic-room-simulator.html', html);
```

```html
<!-- src/index.html -->
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Room/Wave</title><style>/*__INLINE_STYLES__*/</style></head>
<body><main id="app"><h1>Room/Wave</h1><p id="boot-status">Loading acoustic workbench…</p></main><script>/*__WORKER_BOOTSTRAP__*/</script><script>/*__INLINE_SCRIPTS__*/</script></body>
</html>
```

```js
// src/namespace.js
(function (root, factory) {
  const api = factory(root.RoomWave || {});
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function () {
  const SCHEMA_VERSION = 1;
  const SPEED_OF_SOUND = 343;
  return { SCHEMA_VERSION, SPEED_OF_SOUND };
});
```

```css
/* src/styles.css */
:root { color-scheme: dark; --blueprint:#07111f; --panel:#0d1829; --grid:#1b3652; --drawing:#e2e8f0; --wave:#38bdf8; --pressure:#fb923c; }
* { box-sizing:border-box; }
body { margin:0; min-height:100vh; color:var(--drawing); background:var(--blueprint); font-family:system-ui,sans-serif; }
:focus-visible { outline:2px solid var(--wave); outline-offset:3px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior:auto !important; animation-duration:0.001ms !important; transition-duration:0.001ms !important; } }
```

Create `tests/manual-checklist.md` with unchecked sections for direct `file://` launch and zero requests; default geometry; all five source types; room editing and topology rejection; undo/redo; off-room removal; 45° rotation; gain/polarity/delay; all three analysis views; listening-point response; ceiling modes; worker/fallback/cancellation; presets and JSON; keyboard and screen-reader object list; reduced motion; color/contour legends; numerical validation; and measured preview/solve/cancellation timing.

- [ ] **Step 4: Run the build test and full test command**

Run: `npm test`

Expected: PASS with 1 test and 0 failures.

- [ ] **Step 5: Commit the scaffold**

```bash
git add package.json scripts src tests acoustic-room-simulator.html
git commit -m "build: add standalone simulator scaffold"
```

### Task 2: Room geometry and topology-safe edit strokes

**Files:**
- Create: `src/geometry.js`
- Create: `tests/geometry.test.js`

**Interfaces:**
- Produces: `cellKey(x, y)`, `rectangleCells(width, height)`, `roomBounds(cells)`, `analyzeTopology(cells)`, `applyCellStroke(cells, points)`, and `extractWallSegments(cells)`.
- Consumes: `RoomWave` namespace.

- [ ] **Step 1: Write failing geometry tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geometry.js');

test('default rectangle contains 70 connected, hole-free cells', () => {
  const cells = G.rectangleCells(10, 7);
  assert.equal(cells.size, 70);
  assert.deepEqual(G.analyzeTopology(cells), { connected: true, hasHole: false });
});

test('stroke toggles cells atomically and rejects a disconnected result', () => {
  const cells = G.rectangleCells(3, 1);
  assert.deepEqual([...G.applyCellStroke(cells, [{ x: 1, y: 0 }]).cells], [...cells]);
  assert.equal(G.applyCellStroke(cells, [{ x: 1, y: 0 }]).error, 'Room must remain connected.');
  const added = G.applyCellStroke(cells, [{ x: 1, y: 1 }]);
  assert.equal(added.cells.has('1,1'), true);
});

test('wall extraction returns four outer segments for a rectangle', () => {
  assert.equal(G.extractWallSegments(G.rectangleCells(2, 1)).length, 4);
});
```

- [ ] **Step 2: Verify the tests fail before implementation**

Run: `node --test tests/geometry.test.js`

Expected: FAIL because `src/geometry.js` is missing.

- [ ] **Step 3: Implement cell topology, hole detection, strokes, and merged walls**

Use four-neighbor breadth-first search for connectivity. Detect holes by flood-filling empty cells from a one-cell-expanded bounding box; any unvisited empty cell inside that box is enclosed. A stroke chooses add/remove from its first point, applies all points to a clone, then accepts only connected, hole-free output. Merge collinear unit boundary edges before returning wall segments shaped as `{ ax, ay, bx, by, nx, ny }`.

```js
(function (root, factory) {
  const api = factory();
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function () {
  const cellKey = (x, y) => `${x},${y}`;
  const parseCell = key => key.split(',').map(Number);
  const neighbors = ([x, y]) => [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
  const rectangleCells = (width, height) => {
    const cells = new Set();
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) cells.add(cellKey(x, y));
    return cells;
  };
  const roomBounds = cells => {
    const points = [...cells].map(parseCell);
    return { minX: Math.min(...points.map(p => p[0])), minY: Math.min(...points.map(p => p[1])), maxX: Math.max(...points.map(p => p[0] + 1)), maxY: Math.max(...points.map(p => p[1] + 1)) };
  };
  const flood = (start, allowed) => {
    const seen = new Set([cellKey(...start)]), queue = [start];
    while (queue.length) for (const point of neighbors(queue.shift())) {
      const key = cellKey(...point);
      if (!seen.has(key) && allowed(point)) { seen.add(key); queue.push(point); }
    }
    return seen;
  };
  const analyzeTopology = cells => {
    if (!cells.size) return { connected: false, hasHole: false };
    const first = parseCell(cells.values().next().value);
    const connected = flood(first, point => cells.has(cellKey(...point))).size === cells.size;
    const b = roomBounds(cells);
    const outside = flood([b.minX - 1, b.minY - 1], ([x, y]) => x >= b.minX - 1 && x <= b.maxX && y >= b.minY - 1 && y <= b.maxY && !cells.has(cellKey(x, y)));
    let hasHole = false;
    for (let y = b.minY; y < b.maxY; y += 1) for (let x = b.minX; x < b.maxX; x += 1) if (!cells.has(cellKey(x, y)) && !outside.has(cellKey(x, y))) hasHole = true;
    return { connected, hasHole };
  };
  const applyCellStroke = (cells, points) => {
    const next = new Set(cells);
    const mode = next.has(cellKey(points[0].x, points[0].y)) ? 'remove' : 'add';
    for (const { x, y } of points) mode === 'remove' ? next.delete(cellKey(x, y)) : next.add(cellKey(x, y));
    const topology = analyzeTopology(next);
    if (!topology.connected) return { cells, error: 'Room must remain connected.' };
    if (topology.hasHole) return { cells, error: 'Room cannot contain an enclosed hole.' };
    return { cells: next, error: null };
  };
  const extractWallSegments = cells => {
    const groups = new Map();
    const add = (kind, fixed, start, nx, ny) => {
      const key = `${kind}:${fixed}:${nx}:${ny}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(start);
    };
    for (const key of cells) {
      const [x, y] = parseCell(key);
      if (!cells.has(cellKey(x, y - 1))) add('h', y, x, 0, -1);
      if (!cells.has(cellKey(x, y + 1))) add('h', y + 1, x, 0, 1);
      if (!cells.has(cellKey(x - 1, y))) add('v', x, y, -1, 0);
      if (!cells.has(cellKey(x + 1, y))) add('v', x + 1, y, 1, 0);
    }
    const segments = [];
    for (const [key, starts] of groups) {
      const [kind, fixedText, nxText, nyText] = key.split(':');
      const fixed = Number(fixedText), nx = Number(nxText), ny = Number(nyText);
      starts.sort((a, b) => a - b);
      let runStart = starts[0], runEnd = runStart + 1;
      const push = () => segments.push(kind === 'h' ? { ax: runStart, ay: fixed, bx: runEnd, by: fixed, nx, ny } : { ax: fixed, ay: runStart, bx: fixed, by: runEnd, nx, ny });
      for (const start of starts.slice(1)) {
        if (start === runEnd) runEnd += 1;
        else { push(); runStart = start; runEnd = start + 1; }
      }
      push();
    }
    return segments;
  };
  return { cellKey, rectangleCells, roomBounds, analyzeTopology, applyCellStroke, extractWallSegments };
});
```

- [ ] **Step 4: Run geometry tests**

Run: `node --test tests/geometry.test.js`

Expected: PASS with 3 tests and 0 failures.

- [ ] **Step 5: Commit geometry behavior**

```bash
git add src/geometry.js tests/geometry.test.js
git commit -m "feat: add topology-safe room geometry"
```

### Task 3: Project state, source commands, and bounded history

**Files:**
- Create: `src/state.js`
- Create: `tests/state.test.js`

**Interfaces:**
- Consumes: `rectangleCells`, `SCHEMA_VERSION`.
- Produces: `createDefaultProject()`, `reduceProject(project, action)`, `createHistory(project, limit)`, `dispatchHistory(history, action)`, `undo(history)`, and `redo(history)`.

- [ ] **Step 1: Write failing state and history tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(globalThis.RoomWave ||= {}, require('../src/namespace.js'), require('../src/geometry.js'));
const S = require('../src/state.js');

test('default project matches the approved room and solver settings', () => {
  const state = S.createDefaultProject();
  assert.equal(state.room.cells.size, 70);
  assert.equal(state.room.ceilingHeight, 2.5);
  assert.equal(state.analysis.frequency, 74);
  assert.equal(state.analysis.mapResolution, 0.25);
});

test('history reverses one complete room stroke', () => {
  let history = S.createHistory(S.createDefaultProject(), 50);
  history = S.dispatchHistory(history, { type: 'room/stroke', points: [{ x: 0, y: 7 }] });
  assert.equal(history.present.room.cells.size, 71);
  assert.equal(S.undo(history).present.room.cells.size, 70);
  assert.equal(S.redo(S.undo(history)).present.room.cells.size, 71);
});
```

- [ ] **Step 2: Verify state tests fail**

Run: `node --test tests/state.test.js`

Expected: FAIL because `src/state.js` is missing.

- [ ] **Step 3: Implement immutable actions and 50-entry history**

`createDefaultProject()` returns schema version 1, the 10 × 7 room, ceiling 2.5 m, `α = 0.15`, speed 343 m/s, empty sources, listening point `{ x: 5, y: 3.5, z: 1.2 }`, Standard solver quality, 0.25 m map resolution, coherent frequency 74 Hz, and broadband view. `reduceProject` handles room strokes; source add/move/remove/configure/rotate; listening-point move; room settings; and analysis settings. Clamp all numeric controls to the spec ranges. Keep error text in `state.ui.message` rather than throwing for user actions.

```js
const createDefaultProject = () => ({
  schemaVersion: 1,
  room: { cells: RoomWave.rectangleCells(10, 7), ceilingHeight: 2.5, absorption: 0.15 },
  sources: [],
  listeningPoint: { x: 5, y: 3.5, z: 1.2 },
  acoustics: { speedOfSound: 343 },
  analysis: { view: 'broadband', frequency: 74, advancedFrequency: false, quality: 'standard', mapResolution: 0.25 },
  ui: { roomEditMode: false, selectedSourceId: null, message: null, pan: { x: 0, y: 0 }, zoom: 1 }
});
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const reduceProject = (project, action) => {
  if (action.type === 'room/stroke') {
    const result = RoomWave.applyCellStroke(project.room.cells, action.points);
    return result.error ? { ...project, ui: { ...project.ui, message: result.error } } : { ...project, room: { ...project.room, cells: result.cells }, ui: { ...project.ui, message: null } };
  }
  if (action.type === 'source/rotate') return { ...project, sources: project.sources.map(source => source.id === action.id ? { ...source, rotation: (source.rotation + action.delta + 360) % 360 } : source) };
  if (action.type === 'listening/move') return { ...project, listeningPoint: { ...project.listeningPoint, x: action.x, y: action.y, z: clamp(action.z ?? project.listeningPoint.z, 0.1, project.room.ceilingHeight - 0.1) } };
  if (action.type === 'analysis/set') return { ...project, analysis: { ...project.analysis, [action.key]: action.value } };
  return project;
};
const createHistory = (present, limit = 50) => ({ past: [], present, future: [], limit });
const dispatchHistory = (history, action) => {
  const next = reduceProject(history.present, action);
  if (next === history.present) return history;
  return { ...history, past: [...history.past, history.present].slice(-history.limit), present: next, future: [] };
};
const undo = history => history.past.length ? { ...history, future: [history.present, ...history.future], present: history.past.at(-1), past: history.past.slice(0, -1) } : history;
const redo = history => history.future.length ? { ...history, past: [...history.past, history.present].slice(-history.limit), present: history.future[0], future: history.future.slice(1) } : history;
```

- [ ] **Step 4: Run state and geometry tests**

Run: `node --test tests/state.test.js tests/geometry.test.js`

Expected: PASS with 5 tests and 0 failures.

- [ ] **Step 5: Commit state management**

```bash
git add src/state.js tests/state.test.js
git commit -m "feat: add project state and undo history"
```

### Task 4: Source catalog, filters, directivity, and limits

**Files:**
- Create: `src/sources.js`
- Create: `tests/sources.test.js`
- Modify: `src/state.js`

**Interfaces:**
- Produces: `SOURCE_TYPES`, `sourceResponseDb(type, frequency)`, `directionalGain(type, angleRadians)`, `sourceComplexGain(source, frequency)`, `sourceCategory(type)`, and `canAddSource(sources, type)`.
- Consumes: project source actions from `state.js`.

- [ ] **Step 1: Write failing response and limit tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/sources.js');

test('12 dB per octave crossover slopes match declared source bands', () => {
  assert.equal(A.sourceResponseDb('hp-bookshelf', 80), 0);
  assert.equal(A.sourceResponseDb('hp-bookshelf', 40), -12);
  assert.equal(A.sourceResponseDb('lp-subwoofer', 80), 0);
  assert.equal(A.sourceResponseDb('lp-subwoofer', 160), -12);
});

test('nominal 90 degree directivity is smooth and rear-attenuated', () => {
  assert.equal(A.directionalGain('bookshelf', 0), 1);
  assert.ok(Math.abs(20 * Math.log10(A.directionalGain('bookshelf', Math.PI / 4)) + 6) < 0.2);
  assert.ok(20 * Math.log10(A.directionalGain('bookshelf', Math.PI)) <= -30);
  assert.equal(A.directionalGain('subwoofer', Math.PI), 1);
});

test('speaker and subwoofer category limits are independent', () => {
  const speakers = Array.from({ length: 10 }, (_, id) => ({ id, type: 'bookshelf' }));
  assert.equal(A.canAddSource(speakers, 'full-range').ok, false);
  assert.equal(A.canAddSource(speakers, 'subwoofer').ok, true);
});
```

- [ ] **Step 2: Verify source tests fail**

Run: `node --test tests/sources.test.js`

Expected: FAIL because `src/sources.js` is missing.

- [ ] **Step 3: Implement the five source definitions and complex controls**

Use exact catalog fields `{ id, label, minHz, maxHz, directivity, category, crossover }`. Return `-Infinity` outside nominal hard limits. Inside a crossover skirt, use `-12 * abs(log2(frequency / 80))`. For directional sources, interpolate in dB through control points `[0°, 0 dB]`, `[45°, −6 dB]`, `[90°, −24 dB]`, and `[180°, −30 dB]`; subwoofers return unity. Complex gain uses amplitude `10 ** ((responseDb + source.gainDb) / 20)` and phase `2πf × delaySeconds + (inverted ? π : 0)`.

```js
const SOURCE_TYPES = Object.freeze({
  'full-range': { id:'full-range', label:'Full-range speaker', minHz:20, maxHz:20000, directivity:'directional', category:'speaker', crossover:null },
  bookshelf: { id:'bookshelf', label:'Bookshelf speaker', minHz:50, maxHz:20000, directivity:'directional', category:'speaker', crossover:null },
  subwoofer: { id:'subwoofer', label:'Subwoofer', minHz:20, maxHz:120, directivity:'omni', category:'subwoofer', crossover:null },
  'hp-bookshelf': { id:'hp-bookshelf', label:'High-passed bookshelf', minHz:40, maxHz:120, directivity:'directional', category:'speaker', crossover:{ kind:'high-pass', frequency:80, slopeDbPerOctave:12 } },
  'lp-subwoofer': { id:'lp-subwoofer', label:'Low-passed subwoofer', minHz:20, maxHz:200, directivity:'omni', category:'subwoofer', crossover:{ kind:'low-pass', frequency:80, slopeDbPerOctave:12 } }
});
const sourceResponseDb = (type, frequency) => {
  const definition = SOURCE_TYPES[type];
  if (!definition || frequency < definition.minHz || frequency > definition.maxHz) return -Infinity;
  if (!definition.crossover) return 0;
  const octave = Math.log2(frequency / definition.crossover.frequency);
  if (definition.crossover.kind === 'high-pass' && octave < 0) return 12 * octave;
  if (definition.crossover.kind === 'low-pass' && octave > 0) return -12 * octave;
  return 0;
};
```

Update source-add and source-configure actions in `state.js` to enforce category limits and clamp gain/delay/rotation/height.

- [ ] **Step 4: Run source and state tests**

Run: `node --test tests/sources.test.js tests/state.test.js`

Expected: PASS with all source and state tests green.

- [ ] **Step 5: Commit source behavior**

```bash
git add src/sources.js src/state.js tests/sources.test.js tests/state.test.js
git commit -m "feat: model source response and directivity"
```

### Task 5: Versioned persistence and portable JSON

**Files:**
- Create: `src/persistence.js`
- Create: `tests/persistence.test.js`

**Interfaces:**
- Consumes: `SCHEMA_VERSION`, `analyzeTopology`, source catalog and limits.
- Produces: `projectToDocument(project)`, `parseProjectDocument(text)`, `roomPresetFromProject(project, name)`, and `createStorage(adapter)`.

- [ ] **Step 1: Write failing round-trip and rejection tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(globalThis.RoomWave ||= {}, require('../src/namespace.js'), require('../src/geometry.js'), require('../src/sources.js'));
const P = require('../src/persistence.js');

test('project JSON round-trips Set cells and remains human-readable', () => {
  const project = { schemaVersion: 1, room: { cells: new Set(['0,0']), ceilingHeight: 2.5, absorption: 0.15 }, sources: [], listeningPoint: { x: 0.5, y: 0.5, z: 1.2 }, acoustics: { speedOfSound: 343 }, analysis: { quality: 'standard', mapResolution: 0.25, frequency: 74, view: 'broadband' } };
  const text = P.projectToDocument(project);
  assert.match(text, /\n  "schemaVersion"/);
  assert.deepEqual([...P.parseProjectDocument(text).project.room.cells], ['0,0']);
});

test('invalid imports preserve the current project by returning an error only', () => {
  const result = P.parseProjectDocument('{"schemaVersion":99}');
  assert.equal(result.project, null);
  assert.match(result.error, /schema version 99/i);
});
```

- [ ] **Step 2: Verify persistence tests fail**

Run: `node --test tests/persistence.test.js`

Expected: FAIL because `src/persistence.js` is missing.

- [ ] **Step 3: Implement exact schema validation and storage isolation**

Serialize cells as sorted `{ x, y }` objects. Validate every numeric range, source type/count, room topology, and listening/source position before constructing state. `createStorage(adapter)` uses keys `room-wave:rooms:v1` and `room-wave:projects:v1`, catches quota/security exceptions, and returns `{ ok, value, error }` without mutating app state. Room presets contain name, cells, ceiling height, and absorption only.

```js
const projectToDocument = project => JSON.stringify({
  ...project,
  room: { ...project.room, cells: [...project.room.cells].map(key => { const [x, y] = key.split(',').map(Number); return { x, y }; }).sort((a, b) => a.y - b.y || a.x - b.x) },
  ui: undefined
}, null, 2);
const createStorage = adapter => ({
  load(key) { try { return { ok:true, value:JSON.parse(adapter.getItem(key) || '[]'), error:null }; } catch (error) { return { ok:false, value:null, error:error.message }; } },
  save(key, value) { try { adapter.setItem(key, JSON.stringify(value)); return { ok:true, value, error:null }; } catch (error) { return { ok:false, value:null, error:error.message }; } }
});
```

- [ ] **Step 4: Run persistence tests and the full suite**

Run: `npm test`

Expected: PASS with 0 failures.

- [ ] **Step 5: Commit persistence**

```bash
git add src/persistence.js tests/persistence.test.js
git commit -m "feat: add portable project persistence"
```

### Task 6: Acoustic math, grid policy, and analytic validation

**Files:**
- Create: `src/acoustics.js`
- Create: `tests/acoustics.test.js`

**Interfaces:**
- Produces: `wavelength(f, c)`, `reflectionAmplitude(alpha)`, `solverPolicy(roomBounds, quality, speed)`, `rectangularModes(dimensions, maxHz, speed)`, and `modalTolerance(expectedHz, transformBinHz)`.
- Consumes: room bounds and acoustic settings.

- [ ] **Step 1: Write failing physics tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/acoustics.js');

test('solver policy obeys Courant stability and reports a conservative band', () => {
  const policy = A.solverPolicy({ width: 10, height: 7 }, 'standard', 343);
  assert.equal(policy.dx, 0.075);
  assert.ok(policy.dt <= policy.dx / (343 * Math.sqrt(2)));
  assert.ok(policy.reliableHz >= 400 && policy.reliableHz <= 500);
});

test('rectangular axial modes use all three dimensions', () => {
  const modes = A.rectangularModes({ width: 10, depth: 7, height: 2.5 }, 100, 343);
  assert.ok(modes.some(mode => mode.nx === 1 && Math.abs(mode.frequency - 17.15) < 0.01));
  assert.ok(modes.some(mode => mode.nz === 1 && Math.abs(mode.frequency - 68.6) < 0.01));
});

test('energy absorption converts to amplitude reflection', () => {
  assert.ok(Math.abs(A.reflectionAmplitude(0.15) - Math.sqrt(0.85)) < 1e-12);
});
```

- [ ] **Step 2: Verify acoustic tests fail**

Run: `node --test tests/acoustics.test.js`

Expected: FAIL because `src/acoustics.js` is missing.

- [ ] **Step 3: Implement fixed quality presets and analytical modes**

Use Fast/Standard/High `dx` values `0.15/0.075/0.05 m`, Courant safety factor `0.9`, and reliable frequency `speed / (10 * dx)`. Report estimated cells and gate refined analysis over 160,000 wave cells. Enumerate non-zero `(nx, ny, nz)` triplets, sort by frequency, and label axial/tangential/oblique by the number of non-zero indices. Tolerance is `max(transformBinHz, expectedHz * 0.05)`.

```js
const QUALITY_DX = { fast:0.15, standard:0.075, high:0.05 };
const solverPolicy = ({ width, height }, quality, speed) => {
  const dx = QUALITY_DX[quality], dt = 0.9 * dx / (speed * Math.sqrt(2));
  const widthCells = Math.ceil(width / dx), heightCells = Math.ceil(height / dx);
  return { dx, dt, widthCells, heightCells, cellCount:widthCells * heightCells, stabilityMargin:0.9, reliableHz:speed / (10 * dx), allowed:widthCells * heightCells <= 160000 };
};
const modalTolerance = (expectedHz, transformBinHz) => Math.max(transformBinHz, expectedHz * 0.05);
```

- [ ] **Step 4: Run acoustic tests**

Run: `node --test tests/acoustics.test.js`

Expected: PASS with 3 tests and 0 failures.

- [ ] **Step 5: Commit acoustic fundamentals**

```bash
git add src/acoustics.js tests/acoustics.test.js
git commit -m "feat: add acoustic solver policy and modal math"
```

### Task 7: Coherent low-frequency wave solver

**Files:**
- Create: `src/wave-solver.js`
- Create: `tests/wave-solver.test.js`

**Interfaces:**
- Consumes: room cells, sources, source complex gain, absorption, speed, frequency, solver policy.
- Produces: `createWaveGrid(snapshot)`, `solveCoherent(snapshot, hooks)`, `solveBroadbandImpulse(snapshot, hooks)`, and `sampleField(field, x, y)`.
- Hooks: `{ isCancelled(): boolean, onProgress({ phase, completed, total }): void, yieldControl(): Promise<void> }`.

- [ ] **Step 1: Write failing stability, cancellation, and modal tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(globalThis.RoomWave ||= {}, require('../src/sources.js'), require('../src/acoustics.js'));
const W = require('../src/wave-solver.js');

const rectangleCells = (width, height) => {
  const cells = new Set();
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) cells.add(`${x},${y}`);
  return cells;
};
const fixtureRectangularSolve = (overrides = {}) => ({
  room: { cells: rectangleCells(5, 4), ceilingHeight: 2.5, absorption: 0.15 },
  sources: [{ id: 'sub-1', type: 'subwoofer', x: 1.25, y: 2, z: 0.3, gainDb: 0, delayMs: 0, polarity: 'normal', rotation: 0 }],
  listeningPoint: { x: 3.5, y: 2, z: 1.2 },
  acoustics: { speedOfSound: 343 },
  analysis: { frequency: overrides.frequency || 40, quality: 'fast', mapResolution: 0.25 },
  solver: { dx: overrides.dx || 0.15 }
});

test('coherent solve produces finite normalized values and honors cancellation', async () => {
  const snapshot = fixtureRectangularSolve({ frequency: 40, dx: 0.15 });
  const solved = await W.solveCoherent(snapshot, { isCancelled: () => false, onProgress() {}, async yieldControl() {} });
  assert.equal(solved.levelDb.length, solved.width * solved.height);
  assert.ok(solved.levelDb.every(Number.isFinite));
  await assert.rejects(() => W.solveCoherent(snapshot, { isCancelled: () => true, onProgress() {}, async yieldControl() {} }), /cancelled/i);
});

test('first rectangular axial resonance is within fixed tolerance', async () => {
  const scan = await W.scanResponse(fixtureRectangularSolve({ dx: 0.15 }), [31, 32, 33, 34, 35], { isCancelled: () => false, onProgress() {}, async yieldControl() {} });
  const peak = scan.toSorted((a, b) => b.energy - a.energy)[0].frequency;
  assert.ok(Math.abs(peak - 34.3) <= 1.715);
});
```

- [ ] **Step 2: Verify wave tests fail**

Run: `node --test tests/wave-solver.test.js`

Expected: FAIL because `src/wave-solver.js` is missing.

- [ ] **Step 3: Implement rigid-boundary 2D FDTD with boundary loss**

Use three `Float64Array` pressure buffers and the update:

```text
pNext = (2 − damping) × pNow − (1 − damping) × pPrev + (c × dt / dx)² × laplacian + sourceDrive
```

For a missing neighbor at a rigid boundary, substitute the current cell pressure (zero normal gradient). Apply extra boundary damping derived from `1 - sqrt(1 - α)` only to cells adjacent to a wall. Drive every source coherently using its response, delay, polarity, directivity, and bilinear distribution across nearby cells. Warm up for `max(20 cycles, 0.35 s)`, then lock in in-phase and quadrature components for 10 cycles. Convert magnitude to relative dB using the maximum finite magnitude as 0 dB and clamp the display range to −60…0 dB. Yield and report progress every 64 time steps. Reject immediately with `Error('Calculation cancelled.')` when `isCancelled()` is true.

```js
const stepPressure = (grid, previous, current, next, drive, lambdaSquared) => {
  for (let index = 0; index < current.length; index += 1) {
    if (!grid.inside[index]) { next[index] = 0; continue; }
    const center = current[index];
    let laplacian = 0;
    for (const neighbor of grid.neighbors[index]) laplacian += (neighbor < 0 ? center : current[neighbor]) - center;
    const damping = grid.boundary[index] ? grid.boundaryDamping : grid.airDamping;
    next[index] = (2 - damping) * center - (1 - damping) * previous[index] + lambdaSquared * laplacian + drive[index];
  }
};
```

`solveBroadbandImpulse` injects a band-limited impulse, accumulates time-integrated squared pressure per cell for 0.6 s, and returns normalized energy. `scanResponse` calls the coherent solver for exact requested frequencies and returns mean room energy for numerical validation.

- [ ] **Step 4: Run wave and acoustic tests**

Run: `node --test tests/wave-solver.test.js tests/acoustics.test.js`

Expected: PASS with 0 failures and no non-finite values.

- [ ] **Step 5: Commit the wave solver**

```bash
git add src/wave-solver.js tests/wave-solver.test.js
git commit -m "feat: simulate coherent room waves"
```

### Task 8: Specular ray tracer and five-bounce coverage

**Files:**
- Create: `src/ray-tracer.js`
- Create: `tests/ray-tracer.test.js`

**Interfaces:**
- Consumes: merged wall segments, source directivity/response, absorption, map resolution.
- Produces: `intersectRaySegment(origin, direction, segment)`, `reflect(direction, normal)`, `traceSourcePaths(snapshot, source, options)`, and `accumulateRayCoverage(snapshot, frequencies)`.

- [ ] **Step 1: Write failing intersection and reflection tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/ray-tracer.js');

const rectangleRayFixture = () => ({
  room: { absorption: 0.15, walls: [
    { ax: 0, ay: 0, bx: 5, by: 0, nx: 0, ny: 1 },
    { ax: 5, ay: 0, bx: 5, by: 4, nx: -1, ny: 0 },
    { ax: 5, ay: 4, bx: 0, by: 4, nx: 0, ny: -1 },
    { ax: 0, ay: 4, bx: 0, by: 0, nx: 1, ny: 0 }
  ] },
  acoustics: { speedOfSound: 343 },
  analysis: { mapResolution: 0.25 },
  sources: [{ id: 'full-1', type: 'full-range', x: 1, y: 2, z: 1.1, gainDb: 0, delayMs: 0, polarity: 'normal', rotation: 0 }]
});

test('ray intersection and specular reflection preserve angle', () => {
  const wall = { ax: 2, ay: 0, bx: 2, by: 4, nx: -1, ny: 0 };
  const hit = R.intersectRaySegment({ x: 0, y: 1 }, { x: 1, y: 1 }, wall);
  assert.deepEqual({ x: hit.x, y: hit.y }, { x: 2, y: 3 });
  assert.deepEqual(R.reflect({ x: 1, y: 1 }, { x: -1, y: 0 }), { x: -1, y: 1 });
});

test('path tracing emits direct sound plus exactly five bounce levels', () => {
  const paths = R.traceSourcePaths(rectangleRayFixture(), rectangleRayFixture().sources[0], { angularStepDegrees: 5, maxBounces: 5 });
  assert.ok(paths.some(path => path.bounces === 5));
  assert.ok(paths.every(path => path.bounces <= 5));
});
```

- [ ] **Step 2: Verify ray tests fail**

Run: `node --test tests/ray-tracer.test.js`

Expected: FAIL because `src/ray-tracer.js` is missing.

- [ ] **Step 3: Implement deterministic ray marching**

Launch omnidirectional rays through 360° and directional rays through their full pattern at a 2° standard angular step. Find the nearest positive segment intersection, deposit energy along each segment into heatmap cells using path length, source response, air attenuation, inverse distance, directivity, and `reflectionAmplitude(alpha) ** bounceCount`, then reflect and offset the next origin by `1e-6 m` to avoid self-intersection. Store representative visible paths for the selected source while accumulating all rays for broadband coverage.

```js
const reflect = (direction, normal) => {
  const dot = direction.x * normal.x + direction.y * normal.y;
  return { x:direction.x - 2 * dot * normal.x, y:direction.y - 2 * dot * normal.y };
};
const intersectRaySegment = (origin, direction, segment) => {
  const sx = segment.bx - segment.ax, sy = segment.by - segment.ay;
  const denominator = direction.x * sy - direction.y * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const qx = segment.ax - origin.x, qy = segment.ay - origin.y;
  const distance = (qx * sy - qy * sx) / denominator;
  const unit = (qx * direction.y - qy * direction.x) / denominator;
  return distance > 1e-9 && unit >= 0 && unit <= 1 ? { x:origin.x + distance * direction.x, y:origin.y + distance * direction.y, distance, segment } : null;
};
```

- [ ] **Step 4: Run ray and geometry tests**

Run: `node --test tests/ray-tracer.test.js tests/geometry.test.js`

Expected: PASS with 0 failures.

- [ ] **Step 5: Commit ray tracing**

```bash
git add src/ray-tracer.js tests/ray-tracer.test.js
git commit -m "feat: trace early reflection paths"
```

### Task 9: Analysis aggregation, vertical modes, and listening point

**Files:**
- Create: `src/analysis.js`
- Create: `tests/analysis.test.js`

**Interfaces:**
- Consumes: wave field, ray-band maps, rectangular vertical modes, source/listening heights.
- Produces: `combineBroadbandBands(bands)`, `verticalTransfer(room, sources, listeningPoint, frequencies)`, `resampleMap(field, resolution)`, `sampleListeningPoint(result, point)`, and `diagnoseListeningPoint(context)`.

- [ ] **Step 1: Write failing energy and sampling tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/analysis.js');

test('broadband aggregation averages logarithmic-band energy, not pressure', () => {
  const result = A.combineBroadbandBands([{ energy: new Float64Array([1, 4]), weight: 1 }, { energy: new Float64Array([3, 0]), weight: 1 }]);
  assert.deepEqual([...result], [2, 2]);
});

test('listening-point sampling is bilinear and passive', () => {
  const field = { width: 2, height: 2, dx: 1, originX: 0, originY: 0, levelDb: new Float64Array([0, 2, 2, 4]), phase: new Float64Array(4) };
  assert.equal(A.sampleListeningPoint(field, { x: 0.5, y: 0.5 }).levelDb, 2);
});

test('first vertical mode changes with ceiling height', () => {
  assert.ok(Math.abs(A.firstVerticalMode(2.5, 343) - 68.6) < 0.01);
  assert.ok(Math.abs(A.firstVerticalMode(3.0, 343) - 57.1667) < 0.01);
});
```

- [ ] **Step 2: Verify analysis tests fail**

Run: `node --test tests/analysis.test.js`

Expected: FAIL because `src/analysis.js` is missing.

- [ ] **Step 3: Implement energy aggregation and diagnostic evidence**

Use one-third-octave center bands from 20 Hz to each source's maximum frequency, equal log-band weights, source-response weights, and a raised-cosine crossfade across the wave/ray overlap. Compute the uniform-height vertical transfer from cosine mode shapes at source and listening heights with damping derived from absorption. Resample only after calculation. Listening-point diagnostics rank candidate modal frequencies, pairwise source phase separation, and strongest early paths; return copy shaped as `{ label: 'Likely null', explanation, evidence: [{ label, value }] }` and never claim a unique cause.

```js
const combineBroadbandBands = bands => {
  const result = new Float64Array(bands[0].energy.length), totalWeight = bands.reduce((sum, band) => sum + band.weight, 0);
  for (const band of bands) for (let index = 0; index < result.length; index += 1) result[index] += band.energy[index] * band.weight / totalWeight;
  return result;
};
const firstVerticalMode = (height, speed) => speed / (2 * height);
const bilinear = (values, width, x, y) => {
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = y0 + 1, tx = x - x0, ty = y - y0;
  return values[y0 * width + x0] * (1 - tx) * (1 - ty) + values[y0 * width + x1] * tx * (1 - ty) + values[y1 * width + x0] * (1 - tx) * ty + values[y1 * width + x1] * tx * ty;
};
```

- [ ] **Step 4: Run analysis, wave, and ray tests**

Run: `node --test tests/analysis.test.js tests/wave-solver.test.js tests/ray-tracer.test.js`

Expected: PASS with 0 failures.

- [ ] **Step 5: Commit analysis behavior**

```bash
git add src/analysis.js tests/analysis.test.js
git commit -m "feat: aggregate fields and inspect listening points"
```

### Task 10: Versioned worker protocol and chunked fallback

**Files:**
- Create: `src/worker.js`
- Create: `src/controller.js`
- Create: `tests/worker-protocol.test.js`

**Interfaces:**
- Produces: `createProtocolHandler(dependencies, postMessage)`, `installWorker(scope)`, and `createSimulationController({ workerFactory, fallbackRunner, onEvent })`.
- Message shapes: request `{ type: 'solve'|'cancel', version, snapshot }`; event `{ type: 'progress'|'result'|'error'|'cancelled', version, payload }`.

- [ ] **Step 1: Write failing stale-result and fallback tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(globalThis.RoomWave ||= {}, require('../src/worker.js'));
const C = require('../src/controller.js');

const fakeWorker = () => {
  const worker = {
    messages: [],
    listener: null,
    postMessage(message) { this.messages.push(message); },
    addEventListener(type, listener) { if (type === 'message') this.listener = listener; },
    emit(data) { this.listener({ data }); },
    terminate() {}
  };
  return worker;
};

test('controller discards stale results and publishes only the latest version', async () => {
  const events = [];
  const worker = fakeWorker();
  const controller = C.createSimulationController({ workerFactory: () => worker, fallbackRunner: async () => ({}), onEvent: event => events.push(event) });
  controller.solve({ id: 'old' });
  controller.solve({ id: 'new' });
  worker.emit({ type: 'result', version: 1, payload: { id: 'old' } });
  worker.emit({ type: 'result', version: 2, payload: { id: 'new' } });
  assert.deepEqual(events.filter(e => e.type === 'result').map(e => e.payload.id), ['new']);
});

test('worker construction failure activates the yielding fallback', async () => {
  const events = [];
  const controller = C.createSimulationController({ workerFactory: () => { throw new Error('blocked'); }, fallbackRunner: async () => ({ field: true }), onEvent: e => events.push(e) });
  await controller.solve({});
  assert.ok(events.some(e => e.type === 'fallback'));
  assert.ok(events.some(e => e.type === 'result'));
});
```

- [ ] **Step 2: Verify protocol tests fail**

Run: `node --test tests/worker-protocol.test.js`

Expected: FAIL because worker/controller modules are missing.

- [ ] **Step 3: Implement monotonic versions, cancellation, debounce, and progress**

The worker handler keeps a cancelled-version set and passes `isCancelled` into solvers. The controller increments `version` for every solve, sends cancellation for the prior version, ignores all mismatched events, and revokes its Blob URL when disposed. `schedule(snapshot, 180)` debounces refined solves. The fallback uses `yieldControl: () => new Promise(resolve => setTimeout(resolve, 0))` and emits `{ type: 'fallback', reason: 'Web Worker unavailable; using responsive main-thread calculation.' }`.

```js
const createSimulationController = ({ workerFactory, fallbackRunner, onEvent }) => {
  let version = 0, worker = null;
  try { worker = workerFactory(); } catch (error) { onEvent({ type:'fallback', reason:'Web Worker unavailable; using responsive main-thread calculation.' }); }
  if (worker) worker.addEventListener('message', ({ data }) => { if (data.version === version) onEvent(data); });
  return {
    async solve(snapshot) {
      const current = ++version;
      if (worker) { if (current > 1) worker.postMessage({ type:'cancel', version:current - 1 }); worker.postMessage({ type:'solve', version:current, snapshot }); return current; }
      const payload = await fallbackRunner(snapshot, current);
      if (current === version) onEvent({ type:'result', version:current, payload });
      return current;
    },
    cancel() { const current = version; version += 1; if (worker) worker.postMessage({ type:'cancel', version:current }); },
    dispose() { if (worker) worker.terminate(); }
  };
};
```

- [ ] **Step 4: Run protocol and solver tests**

Run: `node --test tests/worker-protocol.test.js tests/wave-solver.test.js`

Expected: PASS with 0 failures.

- [ ] **Step 5: Commit orchestration**

```bash
git add src/worker.js src/controller.js tests/worker-protocol.test.js
git commit -m "feat: run simulations off the UI thread"
```

### Task 11: Blueprint renderer and render-plan tests

**Files:**
- Create: `src/renderer.js`
- Create: `tests/renderer.test.js`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: project state and current analysis result.
- Produces: `buildRenderPlan(state, result, viewport)`, `renderRoom(ctx, plan)`, `hitTest(plan, point)`, and `fieldColor(view, normalizedValue)`.

- [ ] **Step 1: Write failing render-plan tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/renderer.js');

const renderFixture = () => ({
  room: { cells: new Set(['0,0', '1,0']), ceilingHeight: 2.5, absorption: 0.15 },
  sources: [{ id: 'speaker-1', type: 'bookshelf', x: 0.5, y: 0.5, z: 1.1, rotation: 0 }],
  listeningPoint: { x: 1.5, y: 0.5, z: 1.2 },
  analysis: { view: 'broadband', mapResolution: 0.25 },
  ui: { selectedSourceId: 'speaker-1', pan: { x: 0, y: 0 }, zoom: 1 }
});

test('render plan preserves one-meter grid and reports source hit targets', () => {
  const plan = R.buildRenderPlan(renderFixture(), null, { width: 800, height: 560, dpr: 2 });
  assert.equal(plan.grid.metersPerMajorLine, 1);
  assert.equal(plan.sources.length, 1);
  assert.equal(R.hitTest(plan, plan.sources[0].screen).kind, 'source');
});

test('field palettes are bounded and distinct by view semantics', () => {
  assert.match(R.fieldColor('broadband', 0.5), /^#[0-9a-f]{6}$/i);
  assert.notEqual(R.fieldColor('broadband', 0.5), R.fieldColor('coherent', 0.5));
});
```

- [ ] **Step 2: Verify renderer tests fail**

Run: `node --test tests/renderer.test.js`

Expected: FAIL because `src/renderer.js` is missing.

- [ ] **Step 3: Implement deterministic render plans and layered Canvas drawing**

`buildRenderPlan` converts meters to device-independent screen coordinates and returns ordered layers: blueprint background, room fill, field raster, one-meter grid, walls, contour lines, reflection paths, source cones/icons, listening-point crosshair, and legends. Keep DOM controls outside Canvas. Use a color-vision-safe sequential broadband palette and blue-neutral-amber coherent palette with contours every 3 dB. Scale the backing store by device pixel ratio while keeping hit targets at least 24 CSS pixels.

```js
const LAYER_ORDER = ['blueprint', 'room', 'field', 'grid', 'walls', 'contours', 'paths', 'sourceCones', 'sources', 'listeningPoint', 'legend'];
const buildRenderPlan = (state, result, viewport) => {
  const scale = Math.min((viewport.width - 80) / RoomWave.roomBounds(state.room.cells).maxX, (viewport.height - 80) / RoomWave.roomBounds(state.room.cells).maxY) * state.ui.zoom;
  const toScreen = point => ({ x:40 + state.ui.pan.x + point.x * scale, y:40 + state.ui.pan.y + point.y * scale });
  return { layers:LAYER_ORDER, grid:{ metersPerMajorLine:1, scale }, sources:state.sources.map(source => ({ ...source, screen:toScreen(source), hitRadius:Math.max(12, scale * 0.18) })), listeningPoint:{ ...state.listeningPoint, screen:toScreen(state.listeningPoint) }, result, viewport };
};
```

- [ ] **Step 4: Run renderer tests and rebuild**

Run: `node --test tests/renderer.test.js`

Expected: PASS with 2 tests and 0 failures.

Run: `npm run build`

Expected: build exits 0 and regenerates the standalone HTML file.

- [ ] **Step 5: Commit rendering**

```bash
git add src/renderer.js src/styles.css tests/renderer.test.js acoustic-room-simulator.html
git commit -m "feat: render blueprint acoustic fields"
```

### Task 12: Workbench UI and accessible interactions

**Files:**
- Modify: `src/index.html`
- Modify: `src/styles.css`
- Create: `src/app.js`
- Create: `tests/interactions.test.js`

**Interfaces:**
- Consumes: state/history, controller, renderer, source catalog, persistence.
- Produces: `createApp(document, dependencies)`, `interactionToAction(event, context)`, and the approved workbench UI.

- [ ] **Step 1: Write failing pure interaction tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../src/app.js');

test('arrow keys rotate selected directional sources only outside inputs', () => {
  assert.deepEqual(I.interactionToAction({ key: 'ArrowRight', targetTag: 'CANVAS' }, { selectedSource: { id: 'a', type: 'bookshelf' } }), { type: 'source/rotate', id: 'a', delta: 45 });
  assert.equal(I.interactionToAction({ key: 'ArrowRight', targetTag: 'INPUT' }, { selectedSource: { id: 'a', type: 'bookshelf' } }), null);
  assert.equal(I.interactionToAction({ key: 'ArrowRight', targetTag: 'CANVAS' }, { selectedSource: { id: 's', type: 'subwoofer' } }), null);
});

test('room edit pointer stroke becomes one history action', () => {
  assert.deepEqual(I.interactionToAction({ type: 'pointerstroke', cells: [{ x: 0, y: 7 }, { x: 1, y: 7 }] }, { roomEditMode: true }), { type: 'room/stroke', points: [{ x: 0, y: 7 }, { x: 1, y: 7 }] });
});
```

- [ ] **Step 2: Verify interaction tests fail**

Run: `node --test tests/interactions.test.js`

Expected: FAIL because `src/app.js` is missing.

- [ ] **Step 3: Implement the approved engineering workbench**

Build semantic DOM for the top status bar, draggable source library, room-edit checkbox and contextual undo/redo, canvas, context inspector, analysis-mode controls, frequency strip, response chart, preset/project dialogs, live regions, and collapsed Methodology & validation panel. Implement pointer capture for drags, off-room removal with undoable history, room-edit strokes, pan/zoom, source selection, listening-point placement, 45° keyboard rotation, and keyboard alternatives through the synchronized object list. Disable analysis while topology or source positions are invalid. The UI word is **Listening point**; “measurement probe” appears only in its tooltip/methodology copy.

```js
const interactionToAction = (event, context) => {
  if (event.type === 'pointerstroke' && context.roomEditMode) return { type:'room/stroke', points:event.cells };
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && context.selectedSource && !['INPUT', 'SELECT', 'TEXTAREA'].includes(event.targetTag) && RoomWave.SOURCE_TYPES[context.selectedSource.type].directivity === 'directional') return { type:'source/rotate', id:context.selectedSource.id, delta:event.key === 'ArrowRight' ? 45 : -45 };
  if (event.key === 'Escape' && context.roomEditMode) return { type:'ui/room-edit', value:false };
  return null;
};
```

- [ ] **Step 4: Run interaction tests and full suite**

Run: `npm test`

Expected: PASS with 0 failures.

- [ ] **Step 5: Commit the workbench**

```bash
git add src/index.html src/styles.css src/app.js tests/interactions.test.js
git commit -m "feat: add acoustic analysis workbench"
```

### Task 13: Presets, validation report, and integrated analysis workflow

**Files:**
- Modify: `src/app.js`
- Modify: `src/index.html`
- Modify: `src/styles.css`
- Create: `tests/integration.test.js`

**Interfaces:**
- Consumes: every public module interface.
- Produces: browser-local room presets, complete project import/export, three analysis views, listening-point chart/diagnostics, and methodology report.

- [ ] **Step 1: Write failing integration tests against dependency fakes**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIntegrationModel } = require('../src/app.js');

const integrationFixture = () => ({
  project: {
    room: { cells: new Set(['0,0']), ceilingHeight: 2.5, absorption: 0.15 },
    sources: [], listeningPoint: { x: 0.5, y: 0.5, z: 1.2 },
    acoustics: { speedOfSound: 343 },
    analysis: { quality: 'standard', mapResolution: 0.25, frequency: 74, view: 'broadband' }
  },
  result: { policy: { dx: 0.075, dt: 0.000139, stabilityMargin: 0.9, reliableHz: 457.3 }, elapsedMs: 1800, reflectionBounces: 5 }
});

test('analysis view labels never call ray coverage coherent interference', () => {
  const model = createIntegrationModel(integrationFixture());
  assert.equal(model.views.broadband.subtitle, 'Relative broadband energy');
  assert.equal(model.views.coherent.subtitle, 'Wave pressure and phase');
  assert.equal(model.views.paths.subtitle, 'Direct sound and five reflection bounces');
});

test('methodology reports the inputs needed to judge fidelity', () => {
  const report = createIntegrationModel(integrationFixture()).methodology;
  for (const key of ['waveCellSize', 'timeStep', 'stabilityMargin', 'reliableFrequency', 'absorption', 'speedOfSound', 'elapsedMs', 'reflectionBounces']) assert.ok(key in report);
});
```

- [ ] **Step 2: Verify integration tests fail on missing integrated model**

Run: `node --test tests/integration.test.js`

Expected: FAIL because `createIntegrationModel` is not exported.

- [ ] **Step 3: Wire all analysis and persistence outputs into the UI**

Implement broadband/coherent/reflection view switching, advanced reliable-limit slider extension, progress/cancel status, probe response chart, likely-cause evidence, source/room/listening inspectors, room-shape library, local project library, download via Blob URL, file-input import, and non-destructive error display. Populate the validation panel with analytical versus observed rectangular modes and require each first-order axial mode below 200 Hz to fall within `max(one transform bin, 5%)` before showing a passing badge.

```js
const createIntegrationModel = ({ project, result }) => ({
  views: {
    broadband:{ label:'Broadband coverage', subtitle:'Relative broadband energy' },
    coherent:{ label:'Coherent frequency', subtitle:'Wave pressure and phase' },
    paths:{ label:'Reflection paths', subtitle:'Direct sound and five reflection bounces' }
  },
  methodology: {
    waveCellSize:result.policy.dx, timeStep:result.policy.dt, stabilityMargin:result.policy.stabilityMargin,
    reliableFrequency:result.policy.reliableHz, absorption:project.room.absorption, speedOfSound:project.acoustics.speedOfSound,
    elapsedMs:result.elapsedMs, reflectionBounces:result.reflectionBounces
  }
});
```

- [ ] **Step 4: Run the complete automated suite and build**

Run: `npm test`

Expected: all tests PASS with 0 failures.

Run: `npm run build`

Expected: build exits 0 and `acoustic-room-simulator.html` is regenerated.

- [ ] **Step 5: Commit integrated analysis**

```bash
git add src tests acoustic-room-simulator.html
git commit -m "feat: integrate acoustic analysis and presets"
```

### Task 14: Standalone, numerical, accessibility, and performance verification

**Files:**
- Modify: `tests/manual-checklist.md`
- Modify: `acoustic-room-simulator.html`

**Interfaces:**
- Consumes: finished generated deliverable and all acceptance criteria.
- Produces: fresh automated output, completed manual checklist, measured performance values, and a clean final worktree.

- [ ] **Step 1: Run fresh full verification**

Run: `npm test`

Expected: 0 failing tests.

Run: `npm run build`

Expected: build exits 0.

- [ ] **Step 2: Prove standalone packaging constraints**

Run: `rg -n "<(script|link)[^>]+(src|href)=|https?://" acoustic-room-simulator.html`

Expected: no matches.

Run: `du -h acoustic-room-simulator.html`

Expected: size is reported and recorded in `tests/manual-checklist.md`; no arbitrary size gate is imposed.

- [ ] **Step 3: Open the file directly and complete browser checks**

Run: `open acoustic-room-simulator.html`

In browser developer tools, verify the page URL uses `file://`, Network shows zero requests, the default room and source workflow function, workers run or the fallback is identified, stale solves cancel, presets and JSON round-trip, keyboard focus/rotation work, reduced motion works, and all three analysis views have accurate legends. Record browser version and mark each exact checkbox in `tests/manual-checklist.md`.

- [ ] **Step 4: Record numerical and performance evidence**

For the default 10 × 7 × 2.5 m room at Standard quality, record preview latency, refined solve time, cancellation latency, internal cell size/count, reliable frequency, and analytical-versus-observed first-order axial modes. The target values are preview ≤100 ms, solve ≤5 s, cancellation ≤100 ms, progress visible after 500 ms, and modal error ≤max(one transform bin, 5%). If a target is missed, leave the checkbox unchecked and record the measured value and visible quality recommendation.

- [ ] **Step 5: Inspect the final diff and commit verification evidence**

Run: `git diff --check`

Expected: no output.

Run: `git status --short`

Expected: only `tests/manual-checklist.md` and a rebuilt `acoustic-room-simulator.html` are modified.

```bash
git add tests/manual-checklist.md acoustic-room-simulator.html
git commit -m "test: verify standalone acoustic simulator"
```
