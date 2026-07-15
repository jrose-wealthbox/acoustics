const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(
  globalThis.RoomWave ||= {},
  require('../src/namespace.js'),
  require('../src/geometry.js'),
  require('../src/sources.js'),
);
const S = require('../src/state.js');

const sourceFixture = (overrides = {}) => ({
  id: 'speaker-1',
  type: 'bookshelf',
  x: 1,
  y: 2,
  z: 1.1,
  gainDb: 0,
  delayMs: 0,
  polarity: 'normal',
  rotation: 0,
  ...overrides,
});

test('default project matches the approved room and solver settings', () => {
  const state = S.createDefaultProject();

  assert.equal(state.schemaVersion, RoomWave.SCHEMA_VERSION);
  assert.equal(state.room.cells.size, 70);
  assert.equal(state.room.ceilingHeight, 2.5);
  assert.equal(state.room.absorption, 0.15);
  assert.deepEqual(state.sources, []);
  assert.deepEqual(state.listeningPoint, { x: 5, y: 3.5, z: 1.2 });
  assert.equal(state.acoustics.speedOfSound, 343);
  assert.deepEqual(state.analysis, {
    view: 'broadband',
    frequency: 74,
    advancedFrequency: false,
    quality: 'standard',
    mapResolution: 0.25,
  });
});

test('room strokes are immutable and report topology errors in UI state', () => {
  const project = S.createDefaultProject();
  const extended = S.reduceProject(project, {
    type: 'room/stroke',
    points: [{ x: 0, y: 7 }],
  });
  const rejected = S.reduceProject(project, {
    type: 'room/stroke',
    points: [{ x: 1, y: 1 }],
  });

  assert.equal(project.room.cells.size, 70);
  assert.equal(extended.room.cells.size, 71);
  assert.equal(extended.ui.message, null);
  assert.equal(rejected.room.cells, project.room.cells);
  assert.equal(rejected.ui.message, 'Room cannot contain an enclosed hole.');
});

test('source actions add, move, configure, rotate, and remove immutable records', () => {
  const project = S.createDefaultProject();
  const source = sourceFixture({ rotation: 350 });
  const added = S.reduceProject(project, { type: 'source/add', source });
  const moved = S.reduceProject(added, {
    type: 'source/move', id: source.id, x: 3, y: 4, z: 20,
  });
  const configured = S.reduceProject(moved, {
    type: 'source/configure',
    id: source.id,
    changes: { gainDb: -20, delayMs: 25, polarity: 'inverted' },
  });
  const rotated = S.reduceProject(configured, {
    type: 'source/rotate', id: source.id, delta: 45,
  });
  const removed = S.reduceProject(rotated, { type: 'source/remove', id: source.id });

  assert.deepEqual(project.sources, []);
  assert.notEqual(added.sources[0], source);
  assert.deepEqual(moved.sources[0], { ...source, x: 3, y: 4, z: 2.4 });
  assert.equal(configured.sources[0].gainDb, -12);
  assert.equal(configured.sources[0].delayMs, 20);
  assert.equal(configured.sources[0].polarity, 'inverted');
  assert.equal(rotated.sources[0].rotation, 35);
  assert.deepEqual(removed.sources, []);
});

test('room, acoustics, listening point, and analysis controls clamp to supported ranges', () => {
  const project = S.reduceProject(S.createDefaultProject(), {
    type: 'source/add',
    source: sourceFixture({ x: 1, y: 1, z: 2.4 }),
  });
  const room = S.reduceProject(project, {
    type: 'room/configure',
    changes: { ceilingHeight: 1, absorption: 2, speedOfSound: 400 },
  });
  const listening = S.reduceProject(room, {
    type: 'listening/move', x: 8, y: 6, z: -1,
  });
  const lowFrequency = S.reduceProject(listening, {
    type: 'analysis/set', key: 'frequency', value: 1,
  });
  const highResolution = S.reduceProject(lowFrequency, {
    type: 'analysis/set', key: 'mapResolution', value: 1,
  });

  assert.equal(room.room.ceilingHeight, 2);
  assert.equal(room.room.absorption, 1);
  assert.equal(room.acoustics.speedOfSound, 360);
  assert.equal(room.sources[0].z, 1.9);
  assert.deepEqual(listening.listeningPoint, { x: 8, y: 6, z: 0.1 });
  assert.equal(lowFrequency.analysis.frequency, 20);
  assert.equal(highResolution.analysis.mapResolution, 1);
});

test('unknown or ineffective actions do not create new state', () => {
  const project = S.createDefaultProject();

  assert.equal(S.reduceProject(project, { type: 'unknown' }), project);
  assert.equal(
    S.reduceProject(project, { type: 'source/remove', id: 'missing' }),
    project,
  );
});

test('history reverses one complete room stroke', () => {
  let history = S.createHistory(S.createDefaultProject(), 50);
  history = S.dispatchHistory(history, {
    type: 'room/stroke',
    points: [{ x: 0, y: 7 }],
  });

  assert.equal(history.present.room.cells.size, 71);
  assert.equal(S.undo(history).present.room.cells.size, 70);
  assert.equal(S.redo(S.undo(history)).present.room.cells.size, 71);
});

test('history is bounded, clears redo on dispatch, and ignores no-op actions', () => {
  let history = S.createHistory(S.createDefaultProject(), 2);
  history = S.dispatchHistory(history, { type: 'analysis/set', key: 'frequency', value: 50 });
  history = S.dispatchHistory(history, { type: 'analysis/set', key: 'frequency', value: 60 });
  history = S.dispatchHistory(history, { type: 'analysis/set', key: 'frequency', value: 70 });

  assert.equal(history.past.length, 2);
  const undone = S.undo(history);
  assert.equal(undone.present.analysis.frequency, 60);
  assert.equal(undone.future.length, 1);

  const branched = S.dispatchHistory(undone, {
    type: 'analysis/set', key: 'frequency', value: 80,
  });
  assert.equal(branched.future.length, 0);
  assert.equal(S.dispatchHistory(branched, { type: 'unknown' }), branched);
  assert.equal(S.undo(S.undo(S.undo(branched))).present.analysis.frequency, 50);
  assert.equal(S.redo(S.redo(S.redo(S.undo(S.undo(branched))))).present.analysis.frequency, 80);
});

test('a zero-entry history retains no undo snapshots', () => {
  const history = S.dispatchHistory(
    S.createHistory(S.createDefaultProject(), 0),
    { type: 'analysis/set', key: 'frequency', value: 80 },
  );

  assert.equal(history.present.analysis.frequency, 80);
  assert.deepEqual(history.past, []);
  assert.equal(S.undo(history), history);
});

test('source add requires stable nonempty identities and rejects duplicate IDs', () => {
  const project = S.createDefaultProject();
  const added = S.reduceProject(project, { type: 'source/add', source: sourceFixture() });
  const duplicate = S.reduceProject(added, {
    type: 'source/add',
    source: sourceFixture({ x: 8 }),
  });

  assert.equal(duplicate.sources.length, 1);
  assert.deepEqual(duplicate.sources[0], added.sources[0]);
  assert.match(duplicate.ui.message, /unique/i);

  for (const source of [
    sourceFixture({ id: '' }),
    sourceFixture({ id: '  ' }),
    sourceFixture({ id: 42 }),
    sourceFixture({ type: '' }),
    sourceFixture({ type: ' future-type ' }),
    sourceFixture({ type: null }),
  ]) {
    const rejected = S.reduceProject(project, { type: 'source/add', source });
    assert.deepEqual(rejected.sources, []);
    assert.match(rejected.ui.message, /identity/i);
  }
});

test('source add atomically rejects malformed generic controls', () => {
  const project = S.createDefaultProject();
  const malformedSources = [
    sourceFixture({ x: undefined }),
    sourceFixture({ y: '2' }),
    sourceFixture({ z: Number.NaN }),
    sourceFixture({ gainDb: 'loud' }),
    sourceFixture({ delayMs: undefined }),
    sourceFixture({ rotation: Infinity }),
    sourceFixture({ polarity: 'sideways' }),
  ];

  for (const source of malformedSources) {
    const rejected = S.reduceProject(project, { type: 'source/add', source });
    assert.deepEqual(rejected.sources, []);
    assert.match(rejected.ui.message, /controls/i);
    assert.equal(source.type, 'bookshelf');
  }
});

test('source add accepts only catalog types and applies type-specific defaults', () => {
  const project = S.createDefaultProject();
  const speaker = S.reduceProject(project, {
    type: 'source/add',
    source: { id: 'speaker-1', type: 'bookshelf', x: 1, y: 2 },
  });
  const subwoofer = S.reduceProject(speaker, {
    type: 'source/add',
    source: { id: 'sub-1', type: 'subwoofer', x: 3, y: 4 },
  });

  assert.deepEqual(speaker.sources[0], {
    id: 'speaker-1',
    type: 'bookshelf',
    x: 1,
    y: 2,
    z: 1.1,
    gainDb: 0,
    delayMs: 0,
    polarity: 'normal',
    rotation: 0,
  });
  assert.deepEqual(subwoofer.sources[1], {
    id: 'sub-1',
    type: 'subwoofer',
    x: 3,
    y: 4,
    z: 0.3,
    gainDb: 0,
    delayMs: 0,
    polarity: 'normal',
    rotation: 0,
  });

  let history = S.createHistory(project);
  const past = history.past;
  history = S.dispatchHistory(history, {
    type: 'source/add',
    source: sourceFixture({ type: 'future-catalog-type' }),
  });
  assert.deepEqual(history.present.sources, []);
  assert.match(history.present.ui.message, /catalog|source type/i);
  assert.equal(history.past, past);
});

test('source add enforces independent category limits without consuming history', () => {
  let history = S.createHistory(S.createDefaultProject(), 50);
  for (let index = 0; index < 10; index += 1) {
    history = S.dispatchHistory(history, {
      type: 'source/add',
      source: { id: `speaker-${index}`, type: 'bookshelf', x: index, y: 1 },
    });
  }
  const speakerPast = history.past;
  history = S.dispatchHistory(history, {
    type: 'source/add',
    source: { id: 'speaker-over-limit', type: 'full-range', x: 1, y: 2 },
  });
  assert.equal(history.present.sources.length, 10);
  assert.match(history.present.ui.message, /at most 10 speaker/i);
  assert.equal(history.past, speakerPast);

  for (let index = 0; index < 4; index += 1) {
    history = S.dispatchHistory(history, {
      type: 'source/add',
      source: { id: `sub-${index}`, type: 'lp-subwoofer', x: index, y: 2 },
    });
  }
  const subwooferPast = history.past;
  history = S.dispatchHistory(history, {
    type: 'source/add',
    source: { id: 'sub-over-limit', type: 'subwoofer', x: 1, y: 3 },
  });
  assert.equal(history.present.sources.length, 14);
  assert.match(history.present.ui.message, /at most 4 subwoofer/i);
  assert.equal(history.past, subwooferPast);
});

test('source configure protects identity and accepts only mutable source controls', () => {
  const added = S.reduceProject(S.createDefaultProject(), {
    type: 'source/add',
    source: sourceFixture(),
  });
  const identityChange = S.reduceProject(added, {
    type: 'source/configure',
    id: 'speaker-1',
    changes: { id: 'speaker-2', type: 'replacement-type', gainDb: 4 },
  });
  const unknownChange = S.reduceProject(added, {
    type: 'source/configure',
    id: 'speaker-1',
    changes: { label: 'Injected metadata' },
  });

  assert.deepEqual(identityChange.sources, added.sources);
  assert.deepEqual(unknownChange.sources, added.sources);
  assert.match(identityChange.ui.message, /cannot be configured/i);
  assert.match(unknownChange.ui.message, /cannot be configured/i);

  const lower = S.reduceProject(added, {
    type: 'source/configure',
    id: 'speaker-1',
    changes: { z: -10, gainDb: -20, delayMs: -1, polarity: 'inverted', rotation: -45 },
  });
  const upper = S.reduceProject(added, {
    type: 'source/configure',
    id: 'speaker-1',
    changes: { z: 10, gainDb: 20, delayMs: 30, rotation: 765 },
  });

  assert.deepEqual(
    {
      z: lower.sources[0].z,
      gainDb: lower.sources[0].gainDb,
      delayMs: lower.sources[0].delayMs,
      polarity: lower.sources[0].polarity,
      rotation: lower.sources[0].rotation,
    },
    { z: 0.1, gainDb: -12, delayMs: 0, polarity: 'inverted', rotation: 315 },
  );
  assert.deepEqual(
    {
      z: upper.sources[0].z,
      gainDb: upper.sources[0].gainDb,
      delayMs: upper.sources[0].delayMs,
      rotation: upper.sources[0].rotation,
    },
    { z: 2.4, gainDb: 6, delayMs: 20, rotation: 45 },
  );
});

test('source move and remove target exactly one stable identity', () => {
  let project = S.reduceProject(S.createDefaultProject(), {
    type: 'source/add', source: sourceFixture(),
  });
  project = S.reduceProject(project, {
    type: 'source/add', source: sourceFixture({ id: 'speaker-2', x: 4 }),
  });
  const moved = S.reduceProject(project, {
    type: 'source/move', id: 'speaker-2', x: 6, y: 5,
  });
  const removed = S.reduceProject(moved, { type: 'source/remove', id: 'speaker-1' });

  assert.deepEqual(moved.sources[0], project.sources[0]);
  assert.deepEqual(moved.sources[1], { ...project.sources[1], x: 6, y: 5 });
  assert.deepEqual(removed.sources.map(source => source.id), ['speaker-2']);
  assert.equal(S.reduceProject(removed, { type: 'source/remove', id: 'missing' }), removed);
});

test('source move preserves omitted coordinates and rejects malformed coordinates without history', () => {
  const added = S.reduceProject(S.createDefaultProject(), {
    type: 'source/add', source: sourceFixture(),
  });
  const xOnly = S.reduceProject(added, {
    type: 'source/move', id: 'speaker-1', x: 4,
  });
  const zOnly = S.reduceProject(added, {
    type: 'source/move', id: 'speaker-1', z: 20,
  });

  assert.deepEqual(xOnly.sources[0], { ...added.sources[0], x: 4 });
  assert.deepEqual(zOnly.sources[0], { ...added.sources[0], z: 2.4 });

  for (const coordinates of [
    { x: Number.NaN },
    { y: '4' },
    { z: Infinity },
    { x: undefined },
  ]) {
    const rejected = S.reduceProject(added, {
      type: 'source/move', id: 'speaker-1', ...coordinates,
    });
    assert.equal(rejected.sources, added.sources);
    assert.match(rejected.ui.message, /coordinates/i);
  }

  let history = S.createHistory(S.createDefaultProject());
  history = S.dispatchHistory(history, { type: 'source/add', source: sourceFixture() });
  const past = history.past;
  history = S.dispatchHistory(history, {
    type: 'source/move', id: 'speaker-1', x: Number.NaN,
  });
  assert.equal(history.past, past);
  assert.deepEqual(history.present.sources[0], sourceFixture());
  assert.match(history.present.ui.message, /coordinates/i);
});

test('listening move preserves omitted coordinates and rejects malformed coordinates without history', () => {
  const project = S.createDefaultProject();
  const xOnly = S.reduceProject(project, { type: 'listening/move', x: 7 });
  const zOnly = S.reduceProject(project, { type: 'listening/move', z: 20 });

  assert.deepEqual(xOnly.listeningPoint, { x: 7, y: 3.5, z: 1.2 });
  assert.deepEqual(zOnly.listeningPoint, { x: 5, y: 3.5, z: 2.4 });
  assert.equal(S.reduceProject(project, { type: 'listening/move' }), project);

  for (const coordinates of [
    { x: Number.NaN },
    { y: '4' },
    { z: Infinity },
    { y: undefined },
  ]) {
    const rejected = S.reduceProject(project, { type: 'listening/move', ...coordinates });
    assert.equal(rejected.listeningPoint, project.listeningPoint);
    assert.match(rejected.ui.message, /coordinates/i);
  }

  let history = S.createHistory(project);
  const past = history.past;
  history = S.dispatchHistory(history, { type: 'listening/move', y: '4' });
  assert.equal(history.past, past);
  assert.equal(history.present.listeningPoint, project.listeningPoint);
  assert.match(history.present.ui.message, /coordinates/i);
});

test('analysis settings accept only their exact approved domains', () => {
  const defaults = S.createDefaultProject();
  const domains = {
    mapResolution: [0.1, 0.25, 0.5, 1],
    quality: ['fast', 'standard', 'high'],
    view: ['broadband', 'coherent', 'paths'],
    advancedFrequency: [false, true],
  };

  for (const [key, values] of Object.entries(domains)) {
    for (const value of values) {
      const next = S.reduceProject(defaults, { type: 'analysis/set', key, value });
      assert.equal(next.analysis[key], value);
    }
  }

  for (const [key, value] of [
    ['mapResolution', 0.09],
    ['mapResolution', 0.2],
    ['mapResolution', 1.01],
    ['mapResolution', '0.25'],
    ['quality', 'ultra'],
    ['view', 'reflections'],
    ['advancedFrequency', 1],
    ['unknown', 'value'],
    ['toString', 'value'],
    ['constructor', 'value'],
    ['hasOwnProperty', 'value'],
  ]) {
    const history = S.createHistory(defaults);
    assert.equal(S.dispatchHistory(history, { type: 'analysis/set', key, value }), history);
  }

  assert.equal(
    S.reduceProject(defaults, { type: 'analysis/set', key: 'frequency', value: -1 })
      .analysis.frequency,
    20,
  );
  assert.equal(
    S.reduceProject(defaults, { type: 'analysis/set', key: 'frequency', value: 1000 })
      .analysis.frequency,
    200,
  );
});

test('room and listening controls enforce both fixed numeric boundaries', () => {
  const defaults = S.createDefaultProject();
  const lower = S.reduceProject(defaults, {
    type: 'room/configure',
    changes: { ceilingHeight: -1, absorption: -1, speedOfSound: -1 },
  });
  const upper = S.reduceProject(defaults, {
    type: 'room/configure',
    changes: { ceilingHeight: 20, absorption: 2, speedOfSound: 500 },
  });

  assert.deepEqual(
    [lower.room.ceilingHeight, lower.room.absorption, lower.acoustics.speedOfSound],
    [2, 0, 300],
  );
  assert.deepEqual(
    [upper.room.ceilingHeight, upper.room.absorption, upper.acoustics.speedOfSound],
    [10, 1, 360],
  );
  assert.equal(
    S.reduceProject(defaults, { type: 'listening/move', x: 1, y: 1, z: -1 })
      .listeningPoint.z,
    0.1,
  );
  assert.equal(
    S.reduceProject(defaults, { type: 'listening/move', x: 1, y: 1, z: 10 })
      .listeningPoint.z,
    2.4,
  );
});

test('history normalizes limits to an integer between zero and fifty', () => {
  const project = S.createDefaultProject();

  assert.equal(S.createHistory(project, -4).limit, 0);
  assert.equal(S.createHistory(project, 0).limit, 0);
  assert.equal(S.createHistory(project, 2.9).limit, 2);
  assert.equal(S.createHistory(project, 50).limit, 50);
  assert.equal(S.createHistory(project, 500).limit, 50);
  assert.equal(S.createHistory(project, Number.NaN).limit, 50);

  let fractional = S.createHistory(project, 2.9);
  fractional = S.dispatchHistory(fractional, {
    type: 'analysis/set', key: 'frequency', value: 50,
  });
  fractional = S.dispatchHistory(fractional, {
    type: 'analysis/set', key: 'frequency', value: 60,
  });
  fractional = S.dispatchHistory(fractional, {
    type: 'analysis/set', key: 'frequency', value: 70,
  });
  assert.equal(fractional.past.length, 2);

  let capped = S.createHistory(project, 500);
  for (let frequency = 20; frequency <= 70; frequency += 1) {
    capped = S.dispatchHistory(capped, { type: 'analysis/set', key: 'frequency', value: frequency });
  }
  assert.equal(capped.past.length, 50);
});

test('message-only rejections do not consume or evict undo snapshots', () => {
  let history = S.createHistory(S.createDefaultProject(), 2);
  history = S.dispatchHistory(history, {
    type: 'analysis/set', key: 'frequency', value: 50,
  });
  history = S.dispatchHistory(history, {
    type: 'analysis/set', key: 'frequency', value: 60,
  });
  const past = history.past;
  const future = history.future;

  history = S.dispatchHistory(history, {
    type: 'room/stroke', points: [{ x: 1, y: 1 }],
  });

  assert.match(history.present.ui.message, /hole/i);
  assert.equal(history.past, past);
  assert.equal(history.future, future);
  assert.equal(S.undo(history).present.analysis.frequency, 50);

  let sources = S.createHistory(S.createDefaultProject(), 2);
  sources = S.dispatchHistory(sources, { type: 'source/add', source: sourceFixture() });
  const sourcesPast = sources.past;
  sources = S.dispatchHistory(sources, { type: 'source/add', source: sourceFixture() });
  assert.match(sources.present.ui.message, /unique/i);
  assert.equal(sources.past, sourcesPast);
});
