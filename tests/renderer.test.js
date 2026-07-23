const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const R = require('../src/renderer.js');

const LAYER_ORDER = [
  'blueprint',
  'room',
  'field',
  'grid',
  'walls',
  'contours',
  'paths',
  'sourceCones',
  'sources',
  'listeningPoint',
  'legend',
];

const renderFixture = () => ({
  room: {
    cells: new Set(['0,0', '1,0']),
    ceilingHeight: 2.5,
    absorption: 0.15,
  },
  sources: [{
    id: 'speaker-1',
    type: 'bookshelf',
    x: 0.5,
    y: 0.5,
    z: 1.1,
    rotation: 0,
  }],
  listeningPoint: { x: 1.5, y: 0.5, z: 1.2 },
  analysis: { view: 'broadband', mapResolution: 0.25 },
  ui: { selectedSourceId: 'speaker-1', pan: { x: 0, y: 0 }, zoom: 1 },
});

const coherentResult = () => ({
  view: 'coherent',
  coherent: true,
  model: 'coherent-wave-pressure',
  width: 3,
  height: 2,
  dx: 0.5,
  originX: 0,
  originY: 0,
  inside: new Uint8Array([1, 1, 1, 1, 1, 1]),
  levelDb: new Float64Array([-30, -24, -18, -12, -6, 0]),
});

const createContext = () => {
  const operations = [];
  const context = {
    canvas: { width: 0, height: 0 },
    operations,
  };
  for (const name of [
    'setTransform', 'save', 'restore', 'fillRect', 'beginPath', 'rect', 'clip',
    'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'closePath', 'setLineDash',
    'translate', 'rotate', 'fillText',
  ]) {
    context[name] = (...args) => operations.push([name, ...args]);
  }
  return context;
};

test('render plan preserves one-meter grid and reports source hit targets', () => {
  const plan = R.buildRenderPlan(
    renderFixture(),
    null,
    { width: 800, height: 560, dpr: 2 },
  );

  assert.deepEqual(plan.layers, LAYER_ORDER);
  assert.equal(plan.grid.metersPerMajorLine, 1);
  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0].hitRadius >= 12, true);
  assert.deepEqual(
    R.hitTest(plan, plan.sources[0].screen),
    { kind: 'source', id: 'speaker-1' },
  );
});

test('off-room sources remain visible with a non-color warning marker', () => {
  const state = renderFixture();
  state.sources[0] = { ...state.sources[0], x: 2.5, y: 0.5 };
  const plan = R.buildRenderPlan(state, null, { width: 800, height: 560, dpr: 1 });
  const context = createContext();

  R.renderRoom(context, plan);

  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0].outside, true);
  assert.equal(plan.sources[0].warning, 'outside-room');
  assert.deepEqual(
    R.hitTest(plan, plan.sources[0].screen),
    { kind: 'source', id: 'speaker-1' },
  );
  assert.ok(context.operations.some(operation => (
    operation[0] === 'setLineDash'
    && operation[1][0] > 0
  )));
});

test('field palettes are bounded, validated, and distinct by view semantics', () => {
  assert.match(R.fieldColor('broadband', 0.5), /^#[0-9a-f]{6}$/i);
  assert.equal(R.fieldColor('broadband', -1), R.fieldColor('broadband', 0));
  assert.equal(R.fieldColor('coherent', 2), R.fieldColor('coherent', 1));
  assert.notEqual(R.fieldColor('broadband', 0.5), R.fieldColor('coherent', 0.5));
  assert.throws(() => R.fieldColor('unknown', 0.5), /view/i);
  assert.throws(() => R.fieldColor('coherent', NaN), /finite/i);
});

test('render plan translates negative room origins into the viewport', () => {
  const state = renderFixture();
  state.room.cells = new Set(['-3,-2', '-2,-2']);
  state.sources[0] = { ...state.sources[0], x: -2.5, y: -1.5 };
  state.listeningPoint = { ...state.listeningPoint, x: -1.5, y: -1.5 };

  const plan = R.buildRenderPlan(state, null, { width: 800, height: 560, dpr: 2 });

  assert.ok(plan.sources[0].screen.x >= 40);
  assert.ok(plan.sources[0].screen.y >= 40);
  assert.ok(plan.listeningPoint.screen.x >= 40);
  assert.ok(plan.listeningPoint.screen.y >= 40);
  assert.deepEqual(plan.bounds, { minX: -3, minY: -2, maxX: -1, maxY: -1 });
});

test('render plan rejects unsafe viewport and transform values before canvas work', () => {
  const state = renderFixture();
  assert.throws(
    () => R.buildRenderPlan(state, null, { width: 80, height: 560, dpr: 2 }),
    /drawable width/i,
  );
  assert.throws(
    () => R.buildRenderPlan(state, null, { width: 800, height: 560, dpr: Infinity }),
    /device pixel ratio/i,
  );
  assert.throws(
    () => R.buildRenderPlan(state, null, { width: 1e308, height: 560, dpr: 1e-308 }),
    /device pixel ratio|backing store|scale/i,
  );
  assert.throws(
    () => R.buildRenderPlan(state, null, { width: 20000, height: 100, dpr: 1 }),
    /backing dimension/i,
  );
  assert.throws(
    () => R.buildRenderPlan(
      { ...state, ui: { ...state.ui, zoom: 101 } },
      null,
      { width: 800, height: 560, dpr: 2 },
    ),
    /zoom/i,
  );
  assert.throws(
    () => R.buildRenderPlan(
      { ...state, ui: { ...state.ui, pan: { x: 1_000_001, y: 0 } } },
      null,
      { width: 800, height: 560, dpr: 2 },
    ),
    /pan/i,
  );
});

test('empty rooms produce an explicit inert render plan', () => {
  const state = renderFixture();
  state.room.cells = new Set();
  state.sources = [];

  const plan = R.buildRenderPlan(state, null, { width: 800, height: 560, dpr: 1 });

  assert.equal(plan.emptyRoom, true);
  assert.equal(plan.field, null);
  assert.deepEqual(plan.roomCells, []);
  assert.equal(R.hitTest(plan, { x: 400, y: 280 }), null);
});

test('field preparation is cached for an immutable result and leaves inputs unchanged', () => {
  const state = renderFixture();
  state.analysis = { ...state.analysis, view: 'coherent' };
  const result = coherentResult();
  let widthReads = 0;
  Object.defineProperty(result, 'width', {
    configurable: true,
    enumerable: true,
    get() {
      widthReads += 1;
      return 3;
    },
  });
  const sourceBefore = { ...state.sources[0] };
  const levelsBefore = [...result.levelDb];

  const first = R.buildRenderPlan(state, result, { width: 800, height: 560, dpr: 1 });
  const readsAfterFirstPlan = widthReads;
  const second = R.buildRenderPlan(state, result, { width: 640, height: 480, dpr: 1 });

  assert.ok(readsAfterFirstPlan > 0);
  assert.equal(widthReads, readsAfterFirstPlan);
  assert.equal(first.field.prepared, second.field.prepared);
  assert.equal(first.field.metadata.layout, 'point-sampled');
  assert.deepEqual(state.sources[0], sourceBefore);
  assert.deepEqual([...result.levelDb], levelsBefore);
});

test('render plan rejects malformed geometry and analysis-result mismatches atomically', () => {
  const malformed = renderFixture();
  malformed.room.cells = new Set(['0,0', 'not-a-cell']);
  assert.throws(
    () => R.buildRenderPlan(malformed, null, { width: 800, height: 560, dpr: 1 }),
    /room cell/i,
  );

  const oversized = renderFixture();
  oversized.room.cells = new Set(['0,0', '30,0']);
  assert.throws(
    () => R.buildRenderPlan(oversized, null, { width: 800, height: 560, dpr: 1 }),
    /30.*30|span/i,
  );

  const state = renderFixture();
  const mismatched = coherentResult();
  let mismatchedWidthReads = 0;
  Object.defineProperty(mismatched, 'width', {
    configurable: true,
    enumerable: true,
    get() {
      mismatchedWidthReads += 1;
      return 3;
    },
  });
  assert.throws(
    () => R.buildRenderPlan(state, mismatched, { width: 800, height: 560, dpr: 1 }),
    /result view.*analysis view/i,
  );
  assert.equal(mismatchedWidthReads, 0);
});

test('malformed path collections are rejected before field scans', () => {
  const state = renderFixture();
  state.analysis = { ...state.analysis, view: 'coherent' };
  const result = coherentResult();
  result.paths = Array.from({ length: 4097 }, () => ({}));
  let widthReads = 0;
  Object.defineProperty(result, 'width', {
    configurable: true,
    enumerable: true,
    get() {
      widthReads += 1;
      return 3;
    },
  });

  assert.throws(
    () => R.buildRenderPlan(state, result, { width: 800, height: 560, dpr: 1 }),
    /4096 paths/i,
  );
  assert.equal(widthReads, 0);
});

test('result coherence metadata must agree with its analysis view before field scans', () => {
  const state = renderFixture();
  state.analysis = { ...state.analysis, view: 'coherent' };
  const result = coherentResult();
  result.coherent = false;
  let widthReads = 0;
  Object.defineProperty(result, 'width', {
    configurable: true,
    enumerable: true,
    get() {
      widthReads += 1;
      return 3;
    },
  });

  assert.throws(
    () => R.buildRenderPlan(state, result, { width: 800, height: 560, dpr: 1 }),
    /coherent.*view|view.*coherent/i,
  );
  assert.equal(widthReads, 0);
});

test('field and path coordinates must derive finite screen positions before rendering', () => {
  const state = renderFixture();
  state.analysis = { ...state.analysis, view: 'coherent' };
  const distantField = coherentResult();
  distantField.originX = 1e308;
  assert.throws(
    () => R.buildRenderPlan(state, distantField, { width: 800, height: 560, dpr: 1 }),
    /field.*screen coordinates/i,
  );

  const distantPath = coherentResult();
  distantPath.paths = [{
    bounces: 0,
    points: [{ x: 0.5, y: 0.5 }, { x: 1e308, y: 0.5 }],
  }];
  assert.throws(
    () => R.buildRenderPlan(state, distantPath, { width: 800, height: 560, dpr: 1 }),
    /path.*screen coordinates/i,
  );
});

test('renderRoom sizes the backing store and executes the ordered canvas layers', () => {
  const state = renderFixture();
  state.analysis = { ...state.analysis, view: 'coherent' };
  const plan = R.buildRenderPlan(
    state,
    coherentResult(),
    { width: 800, height: 560, dpr: 2 },
  );
  const context = createContext();

  const renderedLayers = R.renderRoom(context, plan);

  assert.deepEqual(renderedLayers, LAYER_ORDER);
  assert.equal(context.canvas.width, 1600);
  assert.equal(context.canvas.height, 1120);
  assert.deepEqual(context.operations[0], ['setTransform', 2, 0, 0, 2, 0, 0]);
  assert.ok(context.operations.some(([name]) => name === 'fillRect'));
  assert.ok(context.operations.some(([name]) => name === 'stroke'));
  assert.ok(context.operations.some(([name]) => name === 'fillText'));
});

test('renderRoom rejects forged backing dimensions before touching the canvas', () => {
  const plan = R.buildRenderPlan(
    renderFixture(),
    null,
    { width: 800, height: 560, dpr: 2 },
  );
  const context = createContext();
  const forged = {
    ...plan,
    viewport: { ...plan.viewport, backingWidth: 1_000_000_000 },
  };

  assert.throws(() => R.renderRoom(context, forged), /backing dimension/i);
  assert.equal(context.canvas.width, 0);
  assert.equal(context.canvas.height, 0);
});

test('room canvas styles preserve blueprint sizing and direct pointer handling', () => {
  const css = fs.readFileSync('src/styles.css', 'utf8');

  assert.match(css, /\.room-canvas\s*\{[^}]*display:\s*block/i);
  assert.match(css, /\.room-canvas\s*\{[^}]*inline-size:\s*100%/i);
  assert.match(css, /\.room-canvas\s*\{[^}]*touch-action:\s*none/i);
});
