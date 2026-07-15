const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(
  globalThis.RoomWave ||= {},
  require('../src/namespace.js'),
  require('../src/geometry.js'),
);
const S = require('../src/state.js');

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
  const source = {
    id: 'speaker-1',
    type: 'future-catalog-type',
    x: 1,
    y: 2,
    z: 1.1,
    gainDb: 0,
    delayMs: 0,
    polarity: 'normal',
    rotation: 350,
  };
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
    source: { id: 'speaker-1', x: 1, y: 1, z: 2.4 },
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
    type: 'analysis/set', key: 'mapResolution', value: 5,
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
