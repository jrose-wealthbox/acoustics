const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

Object.assign(
  globalThis.RoomWave ||= {},
  require('../src/sources.js'),
  require('../src/acoustics.js'),
);
const W = require('../src/wave-solver.js');

const rectangleCells = (width, height) => {
  const cells = new Set();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) cells.add(`${x},${y}`);
  }
  return cells;
};

const fixtureRectangularSolve = (overrides = {}) => ({
  room: { cells: rectangleCells(5, 4), ceilingHeight: 2.5, absorption: 0.15 },
  sources: [{
    id: 'sub-1',
    type: 'subwoofer',
    x: 1.25,
    y: 2,
    z: 0.3,
    gainDb: 0,
    delayMs: 0,
    polarity: 'normal',
    rotation: 0,
  }],
  listeningPoint: { x: 3.5, y: 2, z: 1.2 },
  acoustics: { speedOfSound: 343 },
  analysis: {
    frequency: overrides.frequency || 40,
    quality: 'fast',
    mapResolution: 0.25,
  },
  solver: { dx: overrides.dx || 0.15 },
});

const noOpHooks = () => ({
  isCancelled: () => false,
  onProgress() {},
  async yieldControl() {},
});

test('coherent solve produces finite normalized values and honors cancellation', async () => {
  const snapshot = fixtureRectangularSolve({ frequency: 40, dx: 0.15 });
  const solved = await W.solveCoherent(snapshot, noOpHooks());

  assert.equal(solved.levelDb.length, solved.width * solved.height);
  assert.ok(solved.levelDb.every(Number.isFinite));
  await assert.rejects(
    () => W.solveCoherent(snapshot, {
      isCancelled: () => true,
      onProgress() {},
      async yieldControl() {},
    }),
    /cancelled/i,
  );
});

test('first rectangular axial resonance is within fixed tolerance', async () => {
  const scan = await W.scanResponse(
    fixtureRectangularSolve({ dx: 0.15 }),
    [31, 32, 33, 34, 35],
    noOpHooks(),
  );
  const peak = scan.toSorted((a, b) => b.energy - a.energy)[0].frequency;

  assert.ok(Math.abs(peak - 34.3) <= 1.715);
});

test('wave grid follows room occupancy and marks rigid boundaries', () => {
  const snapshot = fixtureRectangularSolve({ dx: 0.25 });
  snapshot.room.cells.delete('4,3');
  const grid = W.createWaveGrid(snapshot);

  assert.deepEqual(
    { width: grid.width, height: grid.height, originX: grid.originX, originY: grid.originY },
    { width: 20, height: 16, originX: 0, originY: 0 },
  );
  assert.equal(grid.inside[15 * grid.width + 19], 0);
  assert.equal(grid.boundary[11 * grid.width + 19], 1);
  assert.ok(grid.dt <= grid.dx / (343 * Math.sqrt(2)));
});

test('field sampling is bilinear for scalar and coherent values', () => {
  const field = {
    width: 2,
    height: 2,
    dx: 1,
    originX: 0,
    originY: 0,
    levelDb: new Float64Array([0, 2, 2, 4]),
    real: new Float64Array([1, 1, -1, -1]),
    imaginary: new Float64Array([0, 0, 0, 0]),
  };

  assert.deepEqual(W.sampleField(field, 0.5, 0.5), {
    levelDb: 2,
    real: 0,
    imaginary: 0,
    magnitude: 0,
    phase: 0,
  });
});

test('broadband impulse returns bounded finite energy and yields during work', async () => {
  const progress = [];
  let yields = 0;
  const solved = await W.solveBroadbandImpulse(fixtureRectangularSolve({ dx: 0.25 }), {
    isCancelled: () => false,
    onProgress: update => progress.push(update),
    async yieldControl() { yields += 1; },
  });

  assert.equal(solved.energy.length, solved.width * solved.height);
  assert.ok(solved.energy.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.equal(Math.max(...solved.energy), 1);
  assert.ok(yields > 0);
  assert.deepEqual(progress.at(-1), {
    phase: 'broadband impulse',
    completed: progress.at(-1).total,
    total: progress.at(-1).total,
  });
});

test('opposite coherent sources cancel before normalization', async () => {
  const snapshot = fixtureRectangularSolve({ frequency: 40, dx: 0.25 });
  snapshot.sources.push({
    ...snapshot.sources[0],
    id: 'sub-2',
    polarity: 'inverted',
  });

  const solved = await W.solveCoherent(snapshot, noOpHooks());

  assert.ok(solved.magnitude.every(value => value === 0));
  assert.ok(solved.levelDb.every(value => value === -60));
});

test('direct calls reject unsafe grids and malformed numerical inputs before allocation', () => {
  const unsafe = fixtureRectangularSolve();
  unsafe.solver.dx = 0.001;
  assert.throws(() => W.createWaveGrid(unsafe), /160,000|computational budget/i);

  const nonFinite = fixtureRectangularSolve();
  nonFinite.acoustics.speedOfSound = Infinity;
  assert.throws(() => W.createWaveGrid(nonFinite), /speedOfSound.*finite/i);

  const hugeSpan = fixtureRectangularSolve();
  hugeSpan.room.cells = new Set(['0,0', '1000000,0']);
  assert.throws(() => W.createWaveGrid(hugeSpan), /30.*30|span/i);
});

test('source validity follows room geometry rather than the nearest lattice sample', async () => {
  const snapshot = fixtureRectangularSolve({ frequency: 40, dx: 0.25 });
  snapshot.room.cells = new Set(['0,0', '1,0', '0,1']);
  snapshot.sources[0] = { ...snapshot.sources[0], x: 0.99, y: 0.99 };

  const solved = await W.solveCoherent(snapshot, noOpHooks());

  assert.ok(solved.magnitude.some(value => value > 0));
});

test('direct calls reject impractical time-step counts before entering the solve loop', () => {
  const script = `
    Object.assign(globalThis.RoomWave ||= {}, require('./src/sources.js'), require('./src/acoustics.js'));
    const W = require('./src/wave-solver.js');
    const cells = new Set();
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 5; x += 1) cells.add(\`${'${x}'},${'${y}'}\`);
    const snapshot = {
      room: { cells, absorption: 0.15 },
      sources: [{ type: 'subwoofer', x: 1.25, y: 2, gainDb: 0, delayMs: 0, polarity: 'normal', rotation: 0 }],
      acoustics: { speedOfSound: 1e10 },
      analysis: { frequency: 40, quality: 'fast' },
      solver: { dx: 0.15 }
    };
    W.solveCoherent(snapshot, { isCancelled: () => false, onProgress() {}, async yieldControl() {} })
      .then(() => process.exit(2))
      .catch(error => { console.error(error.message); process.exit(/step count/i.test(error.message) ? 0 : 3); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 500,
  });

  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('in-flight cancellation is observed before the first 64-step progress interval', async () => {
  const progress = [];
  let cancelled = false;

  await assert.rejects(() => W.solveCoherent(fixtureRectangularSolve(), {
    isCancelled: () => cancelled,
    onProgress: update => progress.push(update),
    async yieldControl() { cancelled = true; },
  }), /cancelled/i);
  assert.ok(progress.at(-1).completed < 64);
});

test('rotating a grid-aligned directional source rotates the wave field', async () => {
  const front = fixtureRectangularSolve({ frequency: 80, dx: 0.25 });
  front.sources[0] = {
    ...front.sources[0],
    type: 'bookshelf',
    rotation: 0,
  };
  const side = {
    ...front,
    sources: [{ ...front.sources[0], rotation: 90 }],
  };

  const [frontField, sideField] = await Promise.all([
    W.solveCoherent(front, noOpHooks()),
    W.solveCoherent(side, noOpHooks()),
  ]);
  const largestShapeChange = frontField.levelDb.reduce((largest, value, index) => (
    Math.max(largest, Math.abs(value - sideField.levelDb[index]))
  ), 0);

  assert.ok(largestShapeChange > 1);
});
