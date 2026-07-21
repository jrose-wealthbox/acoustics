const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(
  globalThis.RoomWave ||= {},
  require('../src/namespace.js'),
  require('../src/geometry.js'),
  require('../src/sources.js'),
);
const P = require('../src/persistence.js');

const projectFixture = (overrides = {}) => ({
  schemaVersion: 1,
  room: {
    cells: new Set(['1,0', '0,0']),
    ceilingHeight: 2.5,
    absorption: 0.15,
  },
  sources: [],
  listeningPoint: { x: 0.5, y: 0.5, z: 1.2 },
  acoustics: { speedOfSound: 343 },
  analysis: {
    quality: 'standard',
    mapResolution: 0.25,
    frequency: 74,
    view: 'broadband',
  },
  ui: { message: 'not persistent' },
  ...overrides,
});

const sourceFixture = (overrides = {}) => ({
  id: 'speaker-1',
  type: 'bookshelf',
  x: 0.5,
  y: 0.5,
  z: 1.1,
  gainDb: 0,
  delayMs: 0,
  polarity: 'normal',
  rotation: 0,
  ...overrides,
});

test('project JSON round-trips Set cells as sorted, human-readable objects', () => {
  const project = projectFixture();
  const text = P.projectToDocument(project);
  const serialized = JSON.parse(text);
  const result = P.parseProjectDocument(text);

  assert.match(text, /\n  "schemaVersion"/);
  assert.deepEqual(serialized.room.cells, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  assert.equal(Object.hasOwn(serialized, 'ui'), false);
  assert.deepEqual([...result.project.room.cells], ['0,0', '1,0']);
  assert.equal(result.error, null);
  assert.equal(project.room.cells instanceof Set, true);
});

test('invalid JSON and unsupported schemas return an error without a project', () => {
  const malformed = P.parseProjectDocument('{');
  const future = P.parseProjectDocument('{"schemaVersion":99}');

  assert.equal(malformed.project, null);
  assert.match(malformed.error, /JSON/i);
  assert.equal(future.project, null);
  assert.match(future.error, /schema version 99/i);
});

test('schema version must be an integer primitive before its value is formatted', () => {
  for (const schemaVersion of [{}, [], '1', null]) {
    const result = P.parseProjectDocument(JSON.stringify({ schemaVersion }));

    assert.equal(result.project, null);
    assert.match(result.error, /project\.schemaVersion.*integer/i);
    assert.doesNotMatch(result.error, /\[object Object\]/);
  }
});

test('imports reject invalid room geometry and numeric project controls', () => {
  const valid = JSON.parse(P.projectToDocument(projectFixture()));
  const invalidDocuments = [
    [{ ...valid, room: { ...valid.room, cells: [] } }, /room\.cells/i],
    [{ ...valid, room: { ...valid.room, cells: [{ x: 0, y: 0 }, { x: 2, y: 0 }] } }, /connected/i],
    [{ ...valid, room: { ...valid.room, ceilingHeight: 10.1 } }, /ceilingHeight/i],
    [{ ...valid, room: { ...valid.room, absorption: -0.01 } }, /absorption/i],
    [{ ...valid, acoustics: { speedOfSound: 361 } }, /speedOfSound/i],
    [{ ...valid, analysis: { ...valid.analysis, frequency: 201 } }, /frequency/i],
    [{ ...valid, analysis: { ...valid.analysis, mapResolution: 0.2 } }, /mapResolution/i],
  ];

  for (const [document, pattern] of invalidDocuments) {
    const result = P.parseProjectDocument(JSON.stringify(document));
    assert.equal(result.project, null);
    assert.match(result.error, pattern);
  }
});

test('grid coordinates reserve safe arithmetic headroom around every imported cell', () => {
  const valid = JSON.parse(P.projectToDocument(projectFixture()));
  const unsafeCoordinates = [
    1e20,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
  ];

  for (const coordinate of unsafeCoordinates) {
    for (const axis of ['x', 'y']) {
      const result = P.parseProjectDocument(JSON.stringify({
        ...valid,
        room: {
          ...valid.room,
          cells: [{ x: 0, y: 0, [axis]: coordinate }],
        },
      }));

      assert.equal(result.project, null);
      assert.match(result.error, new RegExp(`room\\.cells\\[0\\]\\.${axis}.*safe`, 'i'));
    }
  }
});

test('room topology accepts exactly 30 m but rejects larger spans and enclosed holes', () => {
  const valid = JSON.parse(P.projectToDocument(projectFixture()));
  const line = length => Array.from({ length }, (_, x) => ({ x, y: 0 }));
  const exact = P.parseProjectDocument(JSON.stringify({
    ...valid,
    room: { ...valid.room, cells: line(30) },
  }));
  const tooWide = P.parseProjectDocument(JSON.stringify({
    ...valid,
    room: { ...valid.room, cells: line(31) },
  }));
  const holeCells = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      if (x !== 1 || y !== 1) holeCells.push({ x, y });
    }
  }
  const hole = P.parseProjectDocument(JSON.stringify({
    ...valid,
    room: { ...valid.room, cells: holeCells },
  }));

  assert.equal(exact.error, null);
  assert.equal(exact.project.room.cells.size, 30);
  assert.equal(tooWide.project, null);
  assert.match(tooWide.error, /30 × 30/i);
  assert.equal(hole.project, null);
  assert.match(hole.error, /enclosed hole/i);
});

test('imports validate source identity, catalog membership, controls, counts, and position', () => {
  const valid = JSON.parse(P.projectToDocument(projectFixture()));
  const source = sourceFixture();
  const invalidSources = [
    [{ ...source, id: '' }, /sources\[0\]\.id/i],
    [{ ...source, type: '__proto__' }, /sources\[0\]\.type/i],
    [{ ...source, x: 2.5 }, /sources\[0\] position/i],
    [{ ...source, z: 2.5 }, /sources\[0\]\.z/i],
    [{ ...source, gainDb: 7 }, /gainDb/i],
    [{ ...source, delayMs: -1 }, /delayMs/i],
    [{ ...source, polarity: 'sideways' }, /polarity/i],
    [{ ...source, rotation: 360 }, /rotation/i],
  ];

  for (const [candidate, pattern] of invalidSources) {
    const result = P.parseProjectDocument(JSON.stringify({
      ...valid,
      sources: [candidate],
    }));
    assert.equal(result.project, null);
    assert.match(result.error, pattern);
  }

  const tooMany = Array.from({ length: 11 }, (_, index) => ({
    ...source,
    id: `speaker-${index}`,
  }));
  const overLimit = P.parseProjectDocument(JSON.stringify({ ...valid, sources: tooMany }));
  assert.equal(overLimit.project, null);
  assert.match(overLimit.error, /at most 10 speaker/i);
});

test('imports reject duplicate cells and IDs without returning partial state', () => {
  const valid = JSON.parse(P.projectToDocument(projectFixture()));
  const source = sourceFixture();

  for (const [document, pattern] of [
    [{ ...valid, room: { ...valid.room, cells: [{ x: 0, y: 0 }, { x: 0, y: 0 }] } }, /duplicate/i],
    [{ ...valid, sources: [source, { ...source }] }, /unique/i],
  ]) {
    const result = P.parseProjectDocument(JSON.stringify(document));
    assert.deepEqual(result, { project: null, error: result.error });
    assert.match(result.error, pattern);
  }
});

test('listening point and analysis domains are validated without prototype lookup fallthrough', () => {
  const valid = JSON.parse(P.projectToDocument(projectFixture()));
  const invalidDocuments = [
    [{ ...valid, listeningPoint: { x: 5, y: 5, z: 1.2 } }, /listeningPoint position/i],
    [{ ...valid, listeningPoint: { x: 0.5, y: 0.5, z: 0 } }, /listeningPoint\.z/i],
    [{ ...valid, analysis: { ...valid.analysis, quality: 'constructor' } }, /quality/i],
    [{ ...valid, analysis: { ...valid.analysis, view: '__proto__' } }, /view/i],
  ];

  for (const [document, pattern] of invalidDocuments) {
    const result = P.parseProjectDocument(JSON.stringify(document));
    assert.equal(result.project, null);
    assert.match(result.error, pattern);
  }
});

test('advanced frequency is boolean and valid source-bearing projects round-trip', () => {
  const invalid = JSON.parse(P.projectToDocument(projectFixture()));
  invalid.analysis.advancedFrequency = 'true';
  const rejected = P.parseProjectDocument(JSON.stringify(invalid));
  assert.equal(rejected.project, null);
  assert.match(rejected.error, /advancedFrequency.*boolean/i);

  const project = projectFixture({
    sources: [sourceFixture({ polarity: 'inverted', rotation: 45 })],
    analysis: {
      quality: 'high', mapResolution: 0.1, frequency: 120,
      view: 'coherent', advancedFrequency: true,
    },
  });
  const result = P.parseProjectDocument(P.projectToDocument(project));

  assert.equal(result.error, null);
  assert.deepEqual(result.project.sources, project.sources);
  assert.equal(result.project.analysis.advancedFrequency, true);
});

test('room presets contain only portable room fields', () => {
  const preset = P.roomPresetFromProject(projectFixture(), 'Desk room');

  assert.deepEqual(preset, {
    name: 'Desk room',
    cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    ceilingHeight: 2.5,
    absorption: 0.15,
  });
});

test('storage isolates namespaced collections and catches browser storage failures', () => {
  const values = new Map();
  const adapter = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
  const storage = P.createStorage(adapter);
  const rooms = [{ name: 'Desk room' }];

  assert.deepEqual(storage.save('rooms', rooms), { ok: true, value: rooms, error: null });
  assert.equal(values.has('room-wave:rooms:v1'), true);
  assert.deepEqual(storage.load('rooms'), { ok: true, value: rooms, error: null });
  assert.deepEqual(storage.load('projects'), { ok: true, value: [], error: null });
  assert.equal(storage.load('__proto__').ok, false);

  const blocked = P.createStorage({
    getItem() { throw new Error('Security blocked'); },
    setItem() { throw new Error('Quota exceeded'); },
  });
  assert.deepEqual(blocked.load('rooms'), {
    ok: false, value: null, error: 'Security blocked',
  });
  assert.deepEqual(blocked.save('projects', []), {
    ok: false, value: null, error: 'Quota exceeded',
  });
});

test('storage defaults only missing values and rejects empty or malformed JSON', () => {
  for (const stored of ['', 'not-json']) {
    const storage = P.createStorage({
      getItem() { return stored; },
      setItem() {},
    });
    const result = storage.load('projects');

    assert.equal(result.ok, false);
    assert.equal(result.value, null);
    assert.equal(typeof result.error, 'string');
    assert.notEqual(result.error.length, 0);
  }

  const missing = P.createStorage({
    getItem() { return null; },
    setItem() {},
  });
  assert.deepEqual(missing.load('projects'), { ok: true, value: [], error: null });
});

test('storage save failures do not mutate the caller value', () => {
  const value = [{ project: 'current' }];
  const storage = P.createStorage({
    getItem() { return null; },
    setItem() { throw new Error('disk full'); },
  });

  const result = storage.save('projects', value);

  assert.deepEqual(value, [{ project: 'current' }]);
  assert.deepEqual(result, { ok: false, value: null, error: 'disk full' });
});
