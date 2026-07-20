const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const G = require('../src/geometry.js');
const R = require('../src/ray-tracer.js');

const rectangleRayFixture = () => ({
  room: {
    absorption: 0.15,
    walls: [
      { ax: 0, ay: 0, bx: 5, by: 0, nx: 0, ny: 1 },
      { ax: 5, ay: 0, bx: 5, by: 4, nx: -1, ny: 0 },
      { ax: 5, ay: 4, bx: 0, by: 4, nx: 0, ny: -1 },
      { ax: 0, ay: 4, bx: 0, by: 0, nx: 1, ny: 0 },
    ],
  },
  acoustics: { speedOfSound: 343 },
  analysis: { mapResolution: 0.25 },
  sources: [{
    id: 'full-1',
    type: 'full-range',
    x: 1,
    y: 2,
    z: 1.1,
    gainDb: 0,
    delayMs: 0,
    polarity: 'normal',
    rotation: 0,
  }],
});

test('ray intersection and specular reflection preserve angle', () => {
  const wall = { ax: 2, ay: 0, bx: 2, by: 4, nx: -1, ny: 0 };
  const hit = R.intersectRaySegment({ x: 0, y: 1 }, { x: 1, y: 1 }, wall);

  assert.deepEqual({ x: hit.x, y: hit.y }, { x: 2, y: 3 });
  assert.deepEqual(R.reflect({ x: 1, y: 1 }, { x: -1, y: 0 }), { x: -1, y: 1 });
});

test('path tracing emits direct sound plus exactly five bounce levels', () => {
  const snapshot = rectangleRayFixture();
  const paths = R.traceSourcePaths(snapshot, snapshot.sources[0], {
    angularStepDegrees: 5,
    maxBounces: 5,
  });

  assert.ok(paths.some(path => path.bounces === 5));
  assert.ok(paths.every(path => path.bounces <= 5));
});

test('the standard trace is deterministic and launches one ray every two degrees', () => {
  const snapshot = rectangleRayFixture();
  const first = R.traceSourcePaths(snapshot, snapshot.sources[0]);
  const second = R.traceSourcePaths(snapshot, snapshot.sources[0]);

  assert.deepEqual(first, second);
  assert.equal(first.filter(path => path.bounces === 0).length, 180);
  assert.deepEqual([...new Set(first.map(path => path.bounces))], [0, 1, 2, 3, 4, 5]);
});

test('tracing consumes geometry-extracted walls with outward normals', () => {
  const snapshot = rectangleRayFixture();
  snapshot.room.walls = G.extractWallSegments(G.rectangleCells(5, 4));
  const paths = R.traceSourcePaths(snapshot, snapshot.sources[0]);

  assert.equal(paths.filter(path => path.bounces === 0).length, 180);
  assert.ok(paths.some(path => path.bounces === 5));
});

test('a ray that lands exactly on a rectangular corner continues without self-hitting', () => {
  const snapshot = rectangleRayFixture();
  const source = { ...snapshot.sources[0], x: 1, y: 3 };
  const paths = R.traceSourcePaths(snapshot, source, {
    angularStepDegrees: 45,
    maxBounces: 5,
  });
  const cornerRay = paths.filter(path => path.rayIndex === 3);

  assert.equal(cornerRay.length, 6);
  assert.deepEqual(cornerRay.map(path => path.bounces), [0, 1, 2, 3, 4, 5]);
  assert.ok(Math.abs(cornerRay[0].end.x) < 1e-12);
  assert.ok(Math.abs(cornerRay[0].end.y - 4) < 1e-12);
  assert.ok(cornerRay.every(path => path.length > 0 && Number.isFinite(path.length)));
});

test('coverage accumulates finite noncoherent energy per requested frequency', () => {
  const snapshot = rectangleRayFixture();
  snapshot.sources[0] = { ...snapshot.sources[0], type: 'bookshelf' };
  const coverage = R.accumulateRayCoverage(snapshot, [40, 80]);

  assert.equal(coverage.width, 20);
  assert.equal(coverage.height, 16);
  assert.equal(coverage.resolution, 0.25);
  assert.equal(coverage.coherent, false);
  assert.equal(coverage.bands.length, 2);
  assert.equal(coverage.bands[0].frequency, 40);
  assert.ok(coverage.bands[0].energy.every(value => value === 0));
  assert.ok(coverage.bands[1].energy.some(value => value > 0));
  assert.ok(coverage.bands[1].energy.every(Number.isFinite));
  assert.ok(coverage.energy.every(Number.isFinite));
  assert.ok(coverage.paths.every(path => path.sourceId === 'full-1'));
  assert.ok(coverage.paths.some(path => path.bounces === 5));
});

test('ray energy applies source gain, air loss, and reflection absorption as energy', () => {
  const base = rectangleRayFixture();
  const boosted = rectangleRayFixture();
  boosted.sources[0].gainDb = 6;
  const absorbent = rectangleRayFixture();
  absorbent.room.absorption = 1;
  const frequencies = [1000, 20000];
  const sum = values => values.reduce((total, value) => total + value, 0);

  const baseCoverage = R.accumulateRayCoverage(base, frequencies);
  const boostedCoverage = R.accumulateRayCoverage(boosted, frequencies);
  const absorbentCoverage = R.accumulateRayCoverage(absorbent, frequencies);
  const gainRatio = sum(boostedCoverage.energy) / sum(baseCoverage.energy);

  assert.ok(Math.abs(gainRatio - 10 ** (6 / 10)) < 1e-10);
  assert.ok(sum(baseCoverage.bands[1].energy) < sum(baseCoverage.bands[0].energy));
  assert.ok(sum(absorbentCoverage.energy) > 0, 'direct energy remains when reflections absorb fully');
  assert.ok(sum(absorbentCoverage.energy) < sum(baseCoverage.energy));
});

test('public ray calls reject malformed or impractical inputs before tracing', () => {
  const snapshot = rectangleRayFixture();
  const source = snapshot.sources[0];

  assert.throws(() => R.intersectRaySegment(
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    snapshot.room.walls[0],
  ), /direction.*non-zero/i);
  assert.throws(() => R.reflect({ x: 1, y: 0 }, { x: Number.NaN, y: 0 }), /normal/i);
  assert.throws(() => R.reflect(
    { x: Number.MAX_VALUE, y: Number.MAX_VALUE },
    { x: 1, y: 0 },
  ), /direction.*finite derived/i);
  assert.throws(() => R.intersectRaySegment(
    { x: 0, y: 0 },
    { x: Number.MAX_VALUE, y: Number.MAX_VALUE },
    snapshot.room.walls[0],
  ), /direction.*finite derived/i);
  assert.throws(() => R.intersectRaySegment(
    { x: Number.MAX_VALUE, y: 0 },
    { x: -1, y: 0 },
    { ax: -Number.MAX_VALUE, ay: -1, bx: -Number.MAX_VALUE, by: 1, nx: 1, ny: 0 },
  ), /intersection.*finite derived/i);
  assert.throws(() => R.traceSourcePaths(snapshot, source, { angularStepDegrees: 0 }), /angularStepDegrees/i);
  assert.throws(() => R.traceSourcePaths(snapshot, source, { angularStepDegrees: 0.01 }), /ray/i);
  assert.throws(() => R.traceSourcePaths(snapshot, source, { maxBounces: 6 }), /maxBounces/i);
  assert.throws(() => R.accumulateRayCoverage(snapshot, []), /frequencies/i);
  assert.throws(() => R.accumulateRayCoverage(snapshot, [80, Number.NaN]), /frequencies\[1\]/i);
  assert.throws(() => R.accumulateRayCoverage({
    ...snapshot,
    room: { ...snapshot.room, walls: [] },
  }, [80]), /walls.*nonempty/i);
});

test('coverage rejects excessive ray deposits before the hot loop', () => {
  const modulePath = require.resolve('../src/ray-tracer.js');
  const script = `
    const R = require(${JSON.stringify(modulePath)});
    const wall = (ax, ay, bx, by, nx, ny) => ({ ax, ay, bx, by, nx, ny });
    const source = id => ({ id, type: 'full-range', x: 15, y: 15, z: 1.1,
      gainDb: 0, delayMs: 0, polarity: 'normal', rotation: 0 });
    const snapshot = {
      room: { absorption: 0.15, walls: [
        wall(0, 0, 30, 0, 0, 1), wall(30, 0, 30, 30, -1, 0),
        wall(30, 30, 0, 30, 0, -1), wall(0, 30, 0, 0, 1, 0)
      ] },
      acoustics: { speedOfSound: 343 },
      analysis: { mapResolution: 0.1 },
      sources: Array.from({ length: 14 }, (_, index) => source(String(index)))
    };
    try {
      R.accumulateRayCoverage(snapshot, Array.from({ length: 128 }, (_, index) => index + 20));
      process.exitCode = 2;
    } catch (error) {
      if (error instanceof RangeError) process.stdout.write(error.message);
      else throw error;
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 500,
  });

  assert.equal(result.status, 0, `coverage call did not reject promptly: ${result.signal || result.stderr}`);
  assert.match(result.stdout, /work budget/i);
});
