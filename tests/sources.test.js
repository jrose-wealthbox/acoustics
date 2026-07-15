const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/sources.js');

test('source catalog exposes exactly five immutable definitions', () => {
  assert.deepEqual(A.SOURCE_TYPES, {
    'full-range': {
      id: 'full-range',
      label: 'Full-range speaker',
      minHz: 20,
      maxHz: 20000,
      directivity: 'directional',
      category: 'speaker',
      crossover: null,
    },
    bookshelf: {
      id: 'bookshelf',
      label: 'Bookshelf speaker',
      minHz: 50,
      maxHz: 20000,
      directivity: 'directional',
      category: 'speaker',
      crossover: null,
    },
    subwoofer: {
      id: 'subwoofer',
      label: 'Subwoofer',
      minHz: 20,
      maxHz: 120,
      directivity: 'omni',
      category: 'subwoofer',
      crossover: null,
    },
    'hp-bookshelf': {
      id: 'hp-bookshelf',
      label: 'High-passed bookshelf',
      minHz: 40,
      maxHz: 120,
      directivity: 'directional',
      category: 'speaker',
      crossover: { kind: 'high-pass', frequency: 80, slopeDbPerOctave: 12 },
    },
    'lp-subwoofer': {
      id: 'lp-subwoofer',
      label: 'Low-passed subwoofer',
      minHz: 20,
      maxHz: 200,
      directivity: 'omni',
      category: 'subwoofer',
      crossover: { kind: 'low-pass', frequency: 80, slopeDbPerOctave: 12 },
    },
  });
  assert.ok(Object.isFrozen(A.SOURCE_TYPES));
  assert.ok(Object.values(A.SOURCE_TYPES).every(Object.isFrozen));
  assert.ok(Object.values(A.SOURCE_TYPES)
    .filter(definition => definition.crossover)
    .every(definition => Object.isFrozen(definition.crossover)));
});

test('12 dB per octave crossover slopes match declared source bands', () => {
  assert.equal(A.sourceResponseDb('hp-bookshelf', 80), 0);
  assert.equal(A.sourceResponseDb('hp-bookshelf', 40), -12);
  assert.equal(A.sourceResponseDb('hp-bookshelf', 120), 0);
  assert.equal(A.sourceResponseDb('lp-subwoofer', 40), 0);
  assert.equal(A.sourceResponseDb('lp-subwoofer', 80), 0);
  assert.equal(A.sourceResponseDb('lp-subwoofer', 160), -12);
});

test('source responses stop at nominal hard limits', () => {
  assert.equal(A.sourceResponseDb('bookshelf', 49.99), -Infinity);
  assert.equal(A.sourceResponseDb('bookshelf', 50), 0);
  assert.equal(A.sourceResponseDb('subwoofer', 120), 0);
  assert.equal(A.sourceResponseDb('subwoofer', 120.01), -Infinity);
  assert.equal(A.sourceResponseDb('missing', 80), -Infinity);
  assert.equal(A.sourceResponseDb('full-range', Number.NaN), -Infinity);
});

test('nominal 90 degree directivity interpolates exact dB control points', () => {
  const gainDb = angle => 20 * Math.log10(A.directionalGain('bookshelf', angle));

  assert.equal(A.directionalGain('bookshelf', 0), 1);
  assert.ok(Math.abs(gainDb(Math.PI / 4) + 6) < 1e-10);
  assert.ok(Math.abs(gainDb(Math.PI / 2) + 24) < 1e-10);
  assert.ok(Math.abs(gainDb(Math.PI) + 30) < 1e-10);
  assert.ok(Math.abs(gainDb(-Math.PI / 4) + 6) < 1e-10);
  assert.ok(Math.abs(gainDb(3 * Math.PI / 2) + 24) < 1e-10);
  assert.equal(A.directionalGain('subwoofer', Math.PI), 1);
  assert.equal(A.directionalGain('lp-subwoofer', -12), 1);
});

test('complex source gain returns Cartesian response, delay, and polarity', () => {
  const source = {
    type: 'bookshelf',
    gainDb: 0,
    delayMs: 2.5,
    polarity: 'normal',
  };
  const normal = A.sourceComplexGain(source, 100);
  const inverted = A.sourceComplexGain({ ...source, polarity: 'inverted' }, 100);

  assert.ok(Math.abs(normal.real) < 1e-12);
  assert.ok(Math.abs(normal.imaginary - 1) < 1e-12);
  assert.ok(Math.abs(inverted.real) < 1e-12);
  assert.ok(Math.abs(inverted.imaginary + 1) < 1e-12);

  const filtered = A.sourceComplexGain({
    type: 'hp-bookshelf', gainDb: 0, delayMs: 0, polarity: 'normal',
  }, 40);
  assert.ok(Math.abs(filtered.real - (10 ** (-12 / 20))) < 1e-12);
  assert.ok(Math.abs(filtered.imaginary) < 1e-12);
  assert.deepEqual(A.sourceComplexGain(source, 20), { real: 0, imaginary: 0 });
});

test('speaker and subwoofer category limits are independent', () => {
  const speakers = Array.from({ length: 10 }, (_, id) => ({ id, type: 'bookshelf' }));
  const subwoofers = Array.from({ length: 4 }, (_, id) => ({ id, type: 'subwoofer' }));

  assert.equal(A.sourceCategory('full-range'), 'speaker');
  assert.equal(A.sourceCategory('lp-subwoofer'), 'subwoofer');
  assert.equal(A.sourceCategory('missing'), null);
  assert.equal(A.canAddSource(speakers, 'full-range').ok, false);
  assert.equal(A.canAddSource(speakers, 'subwoofer').ok, true);
  assert.equal(A.canAddSource(subwoofers, 'subwoofer').ok, false);
  assert.equal(A.canAddSource(subwoofers, 'bookshelf').ok, true);
  assert.equal(A.canAddSource([], 'missing').ok, false);
});
