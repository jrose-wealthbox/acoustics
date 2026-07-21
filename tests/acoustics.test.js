const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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

test('wavelength converts positive frequency and wave speed to meters', () => {
  assert.equal(A.wavelength(74, 343), 343 / 74);
});

test('modal tolerance is the greater of one transform bin or five percent', () => {
  assert.equal(A.modalTolerance(100, 2), 5);
  assert.equal(A.modalTolerance(20, 2), 2);
});

test('solver presets use fixed spacing and an exact 0.9 Courant margin', () => {
  for (const [quality, dx] of [
    ['fast', 0.15],
    ['standard', 0.075],
    ['high', 0.05],
  ]) {
    const policy = A.solverPolicy({ width: 10, height: 7 }, quality, 343);
    assert.equal(policy.dx, dx);
    assert.equal(policy.dt, 0.9 * dx / (343 * Math.sqrt(2)));
    assert.equal(policy.stabilityMargin, 0.9);
    assert.equal(policy.reliableHz, 343 / (10 * dx));
  }
});

test('refined analysis allows at most 160,000 wave cells', () => {
  const atLimit = A.solverPolicy({ width: 20, height: 20 }, 'high', 343);
  const aboveLimit = A.solverPolicy({ width: 20.01, height: 20 }, 'high', 343);

  assert.equal(atLimit.cellCount, 160000);
  assert.equal(atLimit.allowed, true);
  assert.equal(aboveLimit.cellCount, 160400);
  assert.equal(aboveLimit.allowed, false);
});

test('rectangular modes enumerate and classify every non-zero index family', () => {
  const modes = A.rectangularModes({ width: 10, depth: 7, height: 2.5 }, 100, 343);
  const find = (nx, ny, nz) => modes.find(mode => (
    mode.nx === nx && mode.ny === ny && mode.nz === nz
  ));

  assert.equal(find(1, 0, 0).type, 'axial');
  assert.equal(find(1, 1, 0).type, 'tangential');
  assert.equal(find(1, 1, 1).type, 'oblique');
  assert.equal(find(0, 0, 0), undefined);
});

test('rectangular modes are frequency-sorted and honor an inclusive cutoff', () => {
  const speed = 343;
  const firstWidthMode = speed / (2 * 10);
  const modes = A.rectangularModes(
    { width: 10, depth: 7, height: 2.5 },
    firstWidthMode,
    speed,
  );

  assert.equal(modes.length, 1);
  assert.deepEqual({
    nx: modes[0].nx,
    ny: modes[0].ny,
    nz: modes[0].nz,
    type: modes[0].type,
  }, {
    nx: 1,
    ny: 0,
    nz: 0,
    type: 'axial',
  });
  assert.ok(Math.abs(modes[0].frequency - firstWidthMode) < 1e-12);
  assert.deepEqual(A.rectangularModes(
    { width: 10, depth: 7, height: 2.5 },
    firstWidthMode - 1e-10,
    speed,
  ), []);

  const manyModes = A.rectangularModes({ width: 10, depth: 7, height: 2.5 }, 100, speed);
  assert.ok(manyModes.every((mode, index) => (
    index === 0 || manyModes[index - 1].frequency <= mode.frequency
  )));
  assert.ok(manyModes.every(mode => mode.frequency <= 100));
});

test('rectangular mode candidates survive index-bound floating-point drift', () => {
  const speed = 306;
  const width = 17.5;
  const cutoff = speed / (2 * width);
  const modes = A.rectangularModes({ width, depth: 1, height: 1 }, cutoff, speed);

  assert.equal(modes.length, 1);
  assert.deepEqual(
    { nx: modes[0].nx, ny: modes[0].ny, nz: modes[0].nz, type: modes[0].type },
    { nx: 1, ny: 0, nz: 0, type: 'axial' },
  );
  assert.ok(Math.abs(modes[0].frequency - cutoff) < 1e-12);
});

test('scalar acoustic math rejects non-finite and out-of-domain inputs', () => {
  assert.throws(() => A.wavelength('74', 343), {
    name: 'TypeError', message: /frequency.*finite number/i,
  });
  assert.throws(() => A.wavelength(0, 343), {
    name: 'RangeError', message: /frequency.*greater than zero/i,
  });
  assert.throws(() => A.wavelength(74, Infinity), {
    name: 'TypeError', message: /speed.*finite number/i,
  });

  assert.equal(A.reflectionAmplitude(0), 1);
  assert.equal(A.reflectionAmplitude(1), 0);
  assert.throws(() => A.reflectionAmplitude(Number.NaN), {
    name: 'TypeError', message: /absorption.*finite number/i,
  });
  assert.throws(() => A.reflectionAmplitude(-0.01), {
    name: 'RangeError', message: /absorption.*between 0 and 1/i,
  });
  assert.throws(() => A.reflectionAmplitude(1.01), RangeError);
});

test('solver policy rejects malformed bounds, qualities, and speeds', () => {
  assert.throws(() => A.solverPolicy(null, 'standard', 343), {
    name: 'TypeError', message: /roomBounds.*object/i,
  });
  assert.throws(() => A.solverPolicy({ width: 0, height: 7 }, 'standard', 343), {
    name: 'RangeError', message: /roomBounds\.width.*greater than zero/i,
  });
  assert.throws(() => A.solverPolicy({ width: 10, height: Number.NaN }, 'standard', 343), {
    name: 'TypeError', message: /roomBounds\.height.*finite number/i,
  });
  assert.throws(() => A.solverPolicy({ width: 10, height: 7 }, 'ultra', 343), {
    name: 'RangeError', message: /quality.*fast.*standard.*high/i,
  });
  assert.throws(() => A.solverPolicy({ width: 10, height: 7 }, 'standard', -343), {
    name: 'RangeError', message: /speed.*greater than zero/i,
  });
});

test('rectangular modes reject invalid dimensions and frequency settings', () => {
  const dimensions = { width: 10, depth: 7, height: 2.5 };

  assert.throws(() => A.rectangularModes([], 100, 343), {
    name: 'TypeError', message: /dimensions.*object/i,
  });
  assert.throws(() => A.rectangularModes({ ...dimensions, depth: 0 }, 100, 343), {
    name: 'RangeError', message: /dimensions\.depth.*greater than zero/i,
  });
  assert.throws(() => A.rectangularModes(dimensions, Number.NaN, 343), {
    name: 'TypeError', message: /maxHz.*finite number/i,
  });
  assert.throws(() => A.rectangularModes(dimensions, 100, 0), {
    name: 'RangeError', message: /speed.*greater than zero/i,
  });
});

test('modal tolerance requires positive finite frequencies', () => {
  assert.throws(() => A.modalTolerance(0, 2), {
    name: 'RangeError', message: /expectedHz.*greater than zero/i,
  });
  assert.throws(() => A.modalTolerance(100, '2'), {
    name: 'TypeError', message: /transformBinHz.*finite number/i,
  });
  assert.throws(() => A.modalTolerance(100, Infinity), TypeError);
});

test('wavelength rejects overflow and underflow in its derived result', () => {
  assert.throws(() => A.wavelength(Number.MIN_VALUE, 343), {
    name: 'RangeError', message: /wavelength.*finite positive/i,
  });
  assert.throws(() => A.wavelength(1e308, Number.MIN_VALUE), {
    name: 'RangeError', message: /wavelength.*finite positive/i,
  });
});

test('solver policy rejects non-finite or unsafe derived grid values', () => {
  assert.throws(() => A.solverPolicy({ width: 1e308, height: 7 }, 'standard', 343), {
    name: 'RangeError', message: /widthCells.*positive safe integer/i,
  });
  assert.throws(() => A.solverPolicy({ width: 10, height: 1e308 }, 'standard', 343), {
    name: 'RangeError', message: /heightCells.*positive safe integer/i,
  });
  assert.throws(() => A.solverPolicy(
    { width: 7_500_000, height: 7_500_000 },
    'standard',
    343,
  ), {
    name: 'RangeError', message: /cellCount.*positive safe integer/i,
  });
  assert.throws(() => A.solverPolicy(
    { width: 10, height: 7 },
    'standard',
    Number.MIN_VALUE,
  ), {
    name: 'RangeError', message: /dt.*finite positive/i,
  });
  assert.throws(() => A.solverPolicy({ width: 10, height: 7 }, 'high', 1e308), {
    name: 'RangeError', message: /reliableHz.*finite positive/i,
  });
});

test('rectangular modes reject dimensions that derive non-finite first modes', () => {
  assert.throws(() => A.rectangularModes(
    { width: 1e-308, depth: 7, height: 2.5 },
    100,
    343,
  ), {
    name: 'RangeError', message: /width.*first mode.*finite positive/i,
  });
});

test('rectangular modes use stable magnitudes when squared ratios would overflow', () => {
  const modes = A.rectangularModes(
    { width: 1e-155, depth: 1e-155, height: 1e-155 },
    2e157,
    343,
  );

  assert.equal(modes.length, 3);
  assert.ok(modes.every(mode => mode.type === 'axial'));
  assert.ok(modes.every(mode => Number.isFinite(mode.frequency)));
});

const assertModalCallRejectsPromptly = callSource => {
  const modulePath = require.resolve('../src/acoustics.js');
  const script = `
    const A = require(${JSON.stringify(modulePath)});
    try {
      ${callSource}
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

  assert.equal(
    result.status,
    0,
    `modal call did not reject promptly: ${result.signal || result.stderr}`,
  );
  assert.match(result.stdout, /modal candidate|derived/i);
};

test('rectangular modes reject an impractical finite cutoff before enumeration', () => {
  assertModalCallRejectsPromptly(`
    A.rectangularModes({ width: 10, depth: 7, height: 2.5 }, 1e308, 343);
  `);
});

test('rectangular modes reject a finite speed that underflows derived values', () => {
  assertModalCallRejectsPromptly(`
    A.rectangularModes(
      { width: 10, depth: 7, height: 2.5 },
      100,
      Number.MIN_VALUE,
    );
  `);
});

test('sub-hertz modal cutoffs do not admit modes through a one-hertz tolerance floor', () => {
  const maxHz = 1e-307;
  const modes = A.rectangularModes(
    { width: 1e308, depth: 1e308, height: 1e308 },
    maxHz,
    343,
  );
  const toleranceFor = frequency => Math.max(
    Number.MIN_VALUE,
    Number.EPSILON * Math.max(Math.abs(frequency), Math.abs(maxHz)) * 4,
  );

  assert.ok(modes.every(mode => mode.frequency - maxHz <= toleranceFor(mode.frequency)));
  assert.deepEqual(
    modes.filter(mode => mode.frequency / maxHz >= 17),
    [],
    'modes 17–30× above the cutoff must not be admitted',
  );
  assert.equal(modes.length, 0);
});
