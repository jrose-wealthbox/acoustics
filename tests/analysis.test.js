const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const A = require('../src/analysis.js');

test('broadband aggregation averages logarithmic-band energy, not pressure', () => {
  const result = A.combineBroadbandBands([
    { energy: new Float64Array([1, 4]), weight: 1 },
    { energy: new Float64Array([3, 0]), weight: 1 },
  ]);

  assert.deepEqual([...result], [2, 2]);
});

test('listening-point sampling is bilinear and passive', () => {
  const field = {
    width: 2,
    height: 2,
    dx: 1,
    originX: 0,
    originY: 0,
    levelDb: new Float64Array([0, 2, 2, 4]),
    phase: new Float64Array(4),
  };
  const before = structuredClone(field);

  assert.equal(A.sampleListeningPoint(field, { x: 0.5, y: 0.5 }).levelDb, 2);
  assert.deepEqual(field, before);
});

test('field metadata gives renderers one validated geometry contract', () => {
  const pointField = {
    width: 2,
    height: 3,
    dx: 0.5,
    originX: -2,
    originY: 4,
    energy: new Float64Array(6),
  };

  assert.deepEqual(A.fieldMetadata(pointField), {
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

  const cellField = { ...pointField, dx: undefined, resolution: 0.5 };
  assert.deepEqual(A.fieldMetadata(cellField), {
    width: 2,
    height: 3,
    cellCount: 6,
    spacing: 0.5,
    layout: 'cell-binned',
    originX: -2,
    originY: 4,
    sampleMinX: -1.75,
    sampleMinY: 4.25,
    sampleMaxX: -1.25,
    sampleMaxY: 5.25,
    extentMinX: -2,
    extentMinY: 4,
    extentMaxX: -1,
    extentMaxY: 5.5,
  });
  assert.throws(
    () => A.fieldMetadata({ ...pointField, energy: new Float64Array(5) }),
    /width \* height/i,
  );
  assert.throws(
    () => A.fieldMetadata({
      width: 1,
      height: 1,
      resolution: Number.MAX_VALUE,
      originX: Number.MAX_VALUE,
      originY: 0,
      energy: new Float64Array(1),
    }),
    /bounds.*finite/i,
  );
});

test('first vertical mode changes with ceiling height', () => {
  assert.ok(Math.abs(A.firstVerticalMode(2.5, 343) - 68.6) < 0.01);
  assert.ok(Math.abs(A.firstVerticalMode(3.0, 343) - 57.1667) < 0.01);
});

test('broadband weights include source response and raised-cosine model overlap', () => {
  const wave = new Float64Array([4, 8]);
  const ray = new Float64Array([12, 0]);
  const bands = [
    {
      frequency: 100,
      waveEnergy: wave,
      rayEnergy: ray,
      overlap: { startHz: 80, endHz: 120 },
      weight: 2,
      responseWeight: 0.5,
    },
    { energy: new Float64Array([2, 2]), weight: 1 },
  ];
  const beforeWave = wave.slice();
  const beforeRay = ray.slice();

  const result = A.combineBroadbandBands(bands);

  assert.deepEqual([...result], [5, 3]);
  assert.deepEqual(wave, beforeWave);
  assert.deepEqual(ray, beforeRay);
});

test('raised-cosine overlap uses exact endpoints and nonlinear quarter weights', () => {
  const combineAt = frequency => A.combineBroadbandBands([{
    frequency,
    waveEnergy: new Float64Array([0]),
    rayEnergy: new Float64Array([4]),
    overlap: { startHz: 100, endHz: 200 },
    weight: 1,
  }])[0];

  assert.equal(combineAt(100), 0);
  assert.equal(combineAt(200), 4);
  assert.ok(Math.abs(combineAt(125) - 4 * ((1 - Math.cos(Math.PI / 4)) / 2)) < 1e-12);
});

test('broadband aggregation rejects malformed energy and weights atomically', () => {
  assert.throws(() => A.combineBroadbandBands([]), /nonempty/i);
  assert.throws(() => A.combineBroadbandBands([
    { energy: new Float64Array([1]), weight: 0 },
  ]), /total weight.*greater than zero/i);
  assert.throws(() => A.combineBroadbandBands([
    { energy: new Float64Array([1]), weight: 1 },
    { energy: new Float64Array([1, 2]), weight: 1 },
  ]), /same length/i);
  assert.throws(() => A.combineBroadbandBands([
    { energy: new Float64Array([Number.NaN]), weight: 1 },
  ]), /energy.*finite/i);
  assert.throws(() => A.combineBroadbandBands([
    { energy: new Float64Array([-1]), weight: 1 },
  ]), /energy.*nonnegative/i);
  assert.throws(() => A.combineBroadbandBands([
    { energy: new Float64Array([Number.MAX_VALUE]), weight: Number.MAX_VALUE },
    { energy: new Float64Array([Number.MAX_VALUE]), weight: Number.MAX_VALUE },
  ]), /total weight.*finite/i);
});

test('vertical transfer is finite, height-sensitive, and damped by absorption', () => {
  const frequencies = [50, 68.6, 90];
  const sources = [{ z: 0.3 }, { z: 1.1 }];
  const point = { x: 2, y: 2, z: 1.2 };
  const reflectiveRoom = { ceilingHeight: 2.5, absorption: 0 };
  const dampedRoom = { ceilingHeight: 2.5, absorption: 0.8 };
  const tallerRoom = { ceilingHeight: 3, absorption: 0 };
  const before = structuredClone({ frequencies, sources, point, reflectiveRoom });

  const reflective = A.verticalTransfer(reflectiveRoom, sources, point, frequencies);
  const damped = A.verticalTransfer(dampedRoom, sources, point, frequencies);
  const taller = A.verticalTransfer(tallerRoom, sources, point, frequencies);

  assert.ok(reflective instanceof Float64Array);
  assert.equal(reflective.length, frequencies.length);
  assert.ok(reflective.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(reflective[1] > damped[1]);
  assert.notDeepEqual(reflective, taller);
  assert.deepEqual({ frequencies, sources, point, reflectiveRoom }, before);
});

test('vertical transfer responds to source and listening heights', () => {
  const room = { ceilingHeight: 2.5, absorption: 0.15 };
  const frequencies = [68.6];
  const floorCoupled = A.verticalTransfer(room, [{ z: 0.1 }], { z: 0.1 }, frequencies);
  const listenerAtModeNode = A.verticalTransfer(room, [{ z: 0.1 }], { z: 1.25 }, frequencies);

  assert.ok(floorCoupled[0] > listenerAtModeNode[0]);
});

test('vertical transfer validates finite bounds and caps frequency work', () => {
  const room = { ceilingHeight: 2.5, absorption: 0.15 };
  const point = { z: 1.2 };

  assert.throws(() => A.firstVerticalMode(0, 343), /height.*greater than zero/i);
  assert.throws(() => A.firstVerticalMode(2.5, Infinity), /speed.*finite/i);
  assert.throws(() => A.verticalTransfer(room, [], point, [80]), /sources.*nonempty/i);
  assert.throws(() => A.verticalTransfer(room, [{ z: 3 }], point, [80]), /sources\[0\]\.z.*ceiling/i);
  assert.throws(() => A.verticalTransfer(room, [{ z: 1 }], { z: Number.NaN }, [80]), /listeningPoint\.z.*finite/i);
  assert.throws(() => A.verticalTransfer(room, [{ z: 1 }], point, [0]), /frequencies\[0\].*greater than zero/i);
  assert.throws(() => A.verticalTransfer(room, [{ z: 1 }], point, Array(513).fill(80)), /512/i);
});

test('map resampling interpolates calculated fields and preserves metadata and input', () => {
  const field = {
    width: 2,
    height: 2,
    dx: 1,
    originX: -1,
    originY: 2,
    model: 'fixture',
    levelDb: new Float64Array([0, 2, 2, 4]),
    energy: new Float64Array([0, 4, 4, 8]),
    phase: new Float64Array([0, 0, 0, 0]),
  };
  const before = structuredClone(field);

  const result = A.resampleMap(field, 0.5);

  assert.equal(result.width, 3);
  assert.equal(result.height, 3);
  assert.equal(result.dx, 0.5);
  assert.equal(result.resolution, 0.5);
  assert.equal(result.model, 'fixture');
  assert.equal(result.levelDb[4], 2);
  assert.equal(result.energy[4], 4);
  assert.deepEqual(field, before);
});

test('sampling interpolates coherent components before deriving phase', () => {
  const field = {
    width: 2,
    height: 2,
    resolution: 1,
    originX: 0,
    originY: 0,
    real: new Float64Array([1, 1, -1, -1]),
    imaginary: new Float64Array([0, 0, 0, 0]),
    magnitude: new Float64Array([1, 1, 1, 1]),
    phase: new Float64Array([0, 0, Math.PI, Math.PI]),
  };

  assert.deepEqual(A.sampleListeningPoint(field, { x: 0.5, y: 0.5 }), {
    real: 0,
    imaginary: 0,
    magnitude: 0,
    phase: 0,
  });
});

test('map resampling derives magnitude and phase for Cartesian-only fields', () => {
  const field = {
    width: 2,
    height: 2,
    dx: 1,
    originX: 0,
    originY: 0,
    real: new Float64Array([1, 1, -1, -1]),
    imaginary: new Float64Array(4),
  };
  const before = structuredClone(field);

  const result = A.resampleMap(field, 0.5);

  assert.equal(result.real[4], 0);
  assert.equal(result.imaginary[4], 0);
  assert.equal(result.magnitude[4], 0);
  assert.equal(result.phase[4], 0);
  assert.deepEqual(field, before);
});

test('non-divisible resampling uses one honest uniform interior grid', () => {
  const field = {
    width: 4,
    height: 4,
    dx: 0.1,
    originX: 0,
    originY: 0,
    energy: new Float64Array([
      0, 0.1, 0.2, 0.3,
      0.1, 0.2, 0.3, 0.4,
      0.2, 0.3, 0.4, 0.5,
      0.3, 0.4, 0.5, 0.6,
    ]),
  };

  const result = A.resampleMap(field, 0.25);

  assert.deepEqual({
    width: result.width,
    height: result.height,
    dx: result.dx,
    resolution: result.resolution,
  }, {
    width: 2,
    height: 2,
    dx: 0.25,
    resolution: 0.25,
  });
  assert.ok(Math.abs(result.energy[3] - 0.5) < 1e-12);
  assert.ok(Math.abs(A.sampleListeningPoint(result, { x: 0.25, y: 0.25 }).energy - 0.5) < 1e-12);
  assert.throws(
    () => A.sampleListeningPoint(result, { x: 0.3, y: 0.25 }),
    /inside.*bounds/i,
  );

  const downstream = A.resampleMap(result, 0.1);
  assert.deepEqual(
    { width: downstream.width, height: downstream.height, dx: downstream.dx },
    { width: 3, height: 3, dx: 0.1 },
  );
  assert.ok(Math.abs(A.sampleListeningPoint(downstream, { x: 0.2, y: 0.2 }).energy - 0.4) < 1e-12);
  assert.throws(
    () => A.sampleListeningPoint(downstream, { x: 0.25, y: 0.2 }),
    /inside.*bounds/i,
  );
});

test('resampling and sampling reject invalid shapes, values, and bounds before allocation', () => {
  const field = {
    width: 2,
    height: 2,
    dx: 1,
    originX: 0,
    originY: 0,
    energy: new Float64Array([0, 1, 1, 2]),
  };

  assert.throws(() => A.sampleListeningPoint({ ...field, energy: new Float64Array(3) }, { x: 0, y: 0 }), /width \* height/i);
  assert.throws(() => A.sampleListeningPoint(field, { x: -0.1, y: 0 }), /inside.*bounds/i);
  assert.throws(() => A.sampleListeningPoint(field, { x: 0, y: Infinity }), /point\.y.*finite/i);
  assert.throws(() => A.resampleMap(field, 0), /resolution.*greater than zero/i);
  assert.throws(() => A.resampleMap({ ...field, width: 160001 }, 0.5), /width \* height|cell count/i);
  assert.throws(() => A.resampleMap({ ...field, energy: new Float64Array([0, 1, 1, Number.NaN]) }, 0.5), /energy.*finite/i);
  assert.throws(() => A.resampleMap(field, Number.MIN_VALUE), /resolution.*0\.1.*0\.25.*0\.5.*1/i);
});

test('listening-point diagnostics rank bounded evidence without claiming a unique cause', () => {
  const context = {
    frequency: 69,
    speedOfSound: 343,
    levelDb: -24,
    modes: [
      { frequency: 120, nx: 1, ny: 1, nz: 0 },
      { frequency: 68.6, nx: 0, ny: 0, nz: 1 },
    ],
    sources: [
      { id: 'left', phase: 0 },
      { id: 'right', phase: Math.PI * 0.95 },
    ],
    paths: [
      { length: 5, bounces: 2, attenuationDb: -10 },
      { length: 2, bounces: 0, attenuationDb: -3 },
    ],
  };
  const before = structuredClone(context);

  const result = A.diagnoseListeningPoint(context);

  assert.equal(result.label, 'Likely null');
  assert.match(result.explanation, /likely|may/i);
  assert.match(result.explanation, /not unique|multiple|contribut/i);
  assert.ok(result.evidence.some(item => /mode/i.test(item.label) && /68\.6/.test(item.value)));
  assert.ok(result.evidence.some(item => /phase/i.test(item.label) && /171/.test(item.value)));
  assert.ok(result.evidence.some(item => /path/i.test(item.label) && /2/.test(item.value)));
  assert.ok(result.evidence.every(item => (
    typeof item.label === 'string' && typeof item.value === 'string'
  )));
  assert.deepEqual(context, before);
});

test('diagnostics remain cautious with sparse evidence and reject unbounded input', () => {
  assert.deepEqual(A.diagnoseListeningPoint({}), {
    label: 'Likely null',
    explanation: 'This predicted dip may have multiple contributing causes; the available evidence is not enough to identify a unique cause.',
    evidence: [],
  });
  assert.throws(() => A.diagnoseListeningPoint({
    modes: Array.from({ length: 1025 }, (_, index) => ({ frequency: index + 1 })),
  }), /modes.*1024/i);
  assert.throws(() => A.diagnoseListeningPoint({
    sources: [{ id: 'a', phase: 0 }, { id: 'b', phase: Number.NaN }],
  }), /sources\[1\]\.phase.*finite/i);
});

test('pathological resampling rejects promptly', () => {
  const modulePath = require.resolve('../src/analysis.js');
  const script = `
    const A = require(${JSON.stringify(modulePath)});
    try {
      A.resampleMap({ width: 2, height: 2, dx: 1, originX: 0, originY: 0,
        energy: new Float64Array([0, 1, 1, 2]) }, Number.MIN_VALUE);
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

  assert.equal(result.status, 0, `resampling did not reject promptly: ${result.signal || result.stderr}`);
  assert.match(result.stdout, /resolution.*0\.1.*0\.25.*0\.5.*1/i);
});
