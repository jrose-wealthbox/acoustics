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

test('wall validation accepts closed rectangle and concave polyomino boundaries', () => {
  const rectangle = rectangleRayFixture();
  const concave = rectangleRayFixture();
  concave.room.walls = G.extractWallSegments(new Set(['0,0', '1,0', '0,1']));
  concave.sources[0] = { ...concave.sources[0], x: 0.5, y: 0.5 };

  assert.ok(R.traceSourcePaths(rectangle, rectangle.sources[0], { angularStepDegrees: 30 }).length > 0);
  assert.ok(R.traceSourcePaths(concave, concave.sources[0], { angularStepDegrees: 30 }).length > 0);
});

test('wall validation rejects noncanonical and disconnected boundaries before tracing', () => {
  const assertWallsReject = (walls, pattern) => {
    const snapshot = rectangleRayFixture();
    snapshot.room.walls = walls;
    assert.throws(() => R.traceSourcePaths(snapshot, snapshot.sources[0]), pattern);
  };
  const walls = rectangleRayFixture().room.walls;

  assertWallsReject(walls.slice(0, -1), /closed boundary.*endpoint/i);
  assertWallsReject([...walls, { ...walls[0] }], /duplicate.*wall/i);
  assertWallsReject([...walls, {
    ...walls[0], ax: walls[0].bx, ay: walls[0].by, bx: walls[0].ax, by: walls[0].ay,
  }], /duplicate.*reversed/i);
  assertWallsReject([...walls, { ...walls[0], ax: 1, bx: 4 }], /overlap.*collinear/i);
  assertWallsReject([
    walls[0],
    walls[1],
    { ...walls[2], bx: 2.5 },
    { ...walls[2], ax: 2.5 },
    walls[3],
  ], /adjacent.*same-normal.*merged/i);
  assertWallsReject([...walls,
    { ax: 2, ay: 1, bx: 3, by: 1, nx: 0, ny: 1 },
    { ax: 3, ay: 1, bx: 3, by: 2, nx: -1, ny: 0 },
    { ax: 3, ay: 2, bx: 2, by: 2, nx: 0, ny: -1 },
    { ax: 2, ay: 2, bx: 2, by: 1, nx: 1, ny: 0 },
  ], /one connected boundary.*disconnected loop/i);
  assertWallsReject([
    { ax: 0, ay: 0, bx: 4, by: 0, nx: 0, ny: -1 },
    { ax: 4, ay: 0, bx: 4, by: 4, nx: 1, ny: 0 },
    { ax: 4, ay: 4, bx: 1, by: 4, nx: 0, ny: 1 },
    { ax: 1, ay: 4, bx: 1, by: -1, nx: -1, ny: 0 },
    { ax: 1, ay: -1, bx: 3, by: -1, nx: 0, ny: -1 },
    { ax: 3, ay: -1, bx: 3, by: 3, nx: 1, ny: 0 },
    { ax: 3, ay: 3, bx: 0, by: 3, nx: 0, ny: 1 },
    { ax: 0, ay: 3, bx: 0, by: 0, nx: -1, ny: 0 },
  ], /perpendicular.*intersect/i);
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

test('directional rotation changes the direct ray-energy distribution', () => {
  const east = rectangleRayFixture();
  east.room.absorption = 1;
  east.sources[0] = { ...east.sources[0], type: 'bookshelf', rotation: 0 };
  const west = rectangleRayFixture();
  west.room.absorption = 1;
  west.sources[0] = { ...west.sources[0], type: 'bookshelf', rotation: 180 };
  const eastEnergy = R.accumulateRayCoverage(east, [1000]).energy;
  const westEnergy = R.accumulateRayCoverage(west, [1000]).energy;
  const indexAt = (x, y) => Math.floor(y / 0.25) * 20 + Math.floor(x / 0.25);

  assert.ok(eastEnergy[indexAt(3, 2)] > westEnergy[indexAt(3, 2)]);
  assert.ok(westEnergy[indexAt(0.5, 2)] > eastEnergy[indexAt(0.5, 2)]);
});

test('each bounce applies reflection amplitude before conversion to energy', () => {
  const reflective = rectangleRayFixture();
  reflective.room.absorption = 0;
  const damped = rectangleRayFixture();
  damped.room.absorption = 0.15;
  const reflectiveBand = R.accumulateRayCoverage(reflective, [1000]).bands[0];
  const dampedBand = R.accumulateRayCoverage(damped, [1000]).bands[0];
  const reflection = Math.sqrt(1 - damped.room.absorption);

  for (const bounce of [0, 1, 3, 5]) {
    const ratio = dampedBand.bounceEnergy[bounce]
      / reflectiveBand.bounceEnergy[bounce];
    assert.ok(Math.abs(ratio - (reflection ** bounce) ** 2) < 1e-12);
  }
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

test('coverage rejects excessive wall intersections before the ray loop', () => {
  const modulePath = require.resolve('../src/ray-tracer.js');
  const script = `
    const R = require(${JSON.stringify(modulePath)});
    const walls = [];
    const push = (ax, ay, bx, by) => walls.push({
      ax, ay, bx, by,
      nx: ay === by ? 0 : (by > ay ? 1 : -1),
      ny: ax === bx ? 0 : (bx > ax ? -1 : 1)
    });
    const teeth = 450;
    push(0, 0, 30, 0);
    push(30, 0, 30, 30);
    let x = 30;
    for (let index = 0; index < teeth; index += 1) {
      const next = 0.1 + 29.9 * (teeth - index - 1) / teeth;
      const middle = (x + next) / 2;
      push(x, 30, middle, 30);
      push(middle, 30, middle, 29);
      push(middle, 29, next, 29);
      push(next, 29, next, 30);
      x = next;
    }
    push(0.1, 30, 0, 30);
    push(0, 30, 0, 0);
    const source = id => ({ id, type: 'full-range', x: 15, y: 15, z: 1.1,
      gainDb: 0, delayMs: 0, polarity: 'normal', rotation: 0 });
    const snapshot = {
      room: { absorption: 0.15, walls },
      acoustics: { speedOfSound: 343 },
      analysis: { mapResolution: 0.25 },
      sources: Array.from({ length: 14 }, (_, index) => source(String(index)))
    };
    try {
      R.accumulateRayCoverage(snapshot, [1000]);
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

  assert.equal(result.status, 0, `intersection-heavy call did not reject promptly: ${result.signal || result.stderr}`);
  assert.match(result.stdout, /intersection work budget/i);
});
