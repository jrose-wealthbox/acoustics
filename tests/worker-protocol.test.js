const test = require('node:test');
const assert = require('node:assert/strict');

const Geometry = require('../src/geometry.js');
const Sources = require('../src/sources.js');
const Acoustics = require('../src/acoustics.js');
const WaveSolver = require('../src/wave-solver.js');
const RayTracer = require('../src/ray-tracer.js');
const Analysis = require('../src/analysis.js');
Object.assign(
  globalThis.RoomWave ||= {},
  Geometry,
  Sources,
  Acoustics,
  WaveSolver,
  RayTracer,
  Analysis,
  require('../src/worker.js'),
);
const W = require('../src/worker.js');
const C = require('../src/controller.js');

const numericalDependencies = {
  ...Geometry,
  ...Sources,
  ...Acoustics,
  ...WaveSolver,
  ...RayTracer,
  ...Analysis,
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const fakeWorker = () => ({
  messages: [],
  listeners: new Map(),
  terminated: false,
  postMessage(message) { this.messages.push(message); },
  addEventListener(type, listener) { this.listeners.set(type, listener); },
  emit(type, data) { this.listeners.get(type)?.(type === 'message' ? { data } : data); },
  terminate() { this.terminated = true; },
});

const simulationFixture = view => ({
  room: {
    cells: Geometry.rectangleCells(2, 2),
    walls: Geometry.extractWallSegments(Geometry.rectangleCells(2, 2)),
    ceilingHeight: 2.5,
    absorption: 0.15,
  },
  sources: [{
    id: 'speaker-1',
    type: 'full-range',
    x: 0.75,
    y: 0.75,
    z: 1.1,
    gainDb: 0,
    delayMs: 0,
    polarity: 'normal',
    rotation: 0,
  }],
  listeningPoint: { x: 1.25, y: 1.25, z: 1.2 },
  acoustics: { speedOfSound: 343 },
  analysis: { view, frequency: 40, quality: 'fast', mapResolution: 0.5 },
  solver: { dx: 0.25 },
  ui: { selectedSourceId: 'speaker-1' },
});

test('protocol forwards progress and the result with the request version', async () => {
  const events = [];
  const snapshots = [];
  const handler = W.createProtocolHandler({
    async runSimulation(snapshot, hooks) {
      snapshots.push(snapshot);
      hooks.onProgress({ phase: 'coherent', completed: 1, total: 2 });
      await hooks.yieldControl();
      return { field: true };
    },
  }, event => events.push(event));

  const snapshot = { analysis: { view: 'coherent' }, nested: { value: 1 } };
  await handler({ type: 'solve', version: 7, snapshot });

  assert.notEqual(snapshots[0], snapshot);
  assert.deepEqual(events, [
    {
      type: 'progress',
      version: 7,
      payload: { phase: 'coherent', completed: 1, total: 2 },
    },
    { type: 'result', version: 7, payload: { field: true } },
  ]);
});

test('protocol cancellation is observed by an in-flight solver', async () => {
  const entered = deferred();
  const resume = deferred();
  const events = [];
  const handler = W.createProtocolHandler({
    async runSimulation(_snapshot, hooks) {
      entered.resolve();
      await resume.promise;
      if (hooks.isCancelled()) throw new Error('Calculation cancelled.');
      return { stale: true };
    },
  }, event => events.push(event));

  const solve = handler({ type: 'solve', version: 3, snapshot: {} });
  await entered.promise;
  await handler({ type: 'cancel', version: 3 });
  resume.resolve();
  await solve;

  assert.deepEqual(events, [{ type: 'cancelled', version: 3 }]);
});

test('protocol rejects malformed requests before invoking simulation work', async () => {
  let calls = 0;
  const events = [];
  const handler = W.createProtocolHandler({
    async runSimulation() {
      calls += 1;
      return {};
    },
  }, event => events.push(event));

  await handler({ type: 'solve', version: 1, snapshot: null });
  await handler({ type: 'unknown', version: 2, snapshot: {} });
  await handler({ type: 'solve', version: Number.NaN, snapshot: {} });

  assert.equal(calls, 0);
  assert.deepEqual(events.map(event => [event.type, event.version]), [
    ['error', 1],
    ['error', 2],
    ['error', 0],
  ]);
  assert.ok(events.every(event => typeof event.payload.message === 'string'));
});

test('protocol serializes solver errors without exposing stack data', async () => {
  const events = [];
  const handler = W.createProtocolHandler({
    async runSimulation() {
      throw new RangeError('invalid solver input');
    },
  }, event => events.push(event));

  await handler({ type: 'solve', version: 4, snapshot: {} });

  assert.deepEqual(events, [{
    type: 'error',
    version: 4,
    payload: { name: 'RangeError', message: 'invalid solver input' },
  }]);
});

test('protocol does not infer cancellation from unrelated error text', async () => {
  const events = [];
  const handler = W.createProtocolHandler({
    async runSimulation() {
      throw new Error('This operation cannot be cancelled after completion.');
    },
  }, event => events.push(event));

  await handler({ type: 'solve', version: 5, snapshot: {} });

  assert.equal(events[0].type, 'error');
  assert.equal(events[0].version, 5);
});

test('installWorker validates its scope and attaches the versioned handler', async () => {
  const events = [];
  const listeners = new Map();
  const scope = {
    RoomWave: {
      async runSimulation() { return { ok: true }; },
    },
    postMessage(event) { events.push(event); },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };

  const handler = W.installWorker(scope);
  await listeners.get('message')({ data: { type: 'solve', version: 1, snapshot: {} } });

  assert.equal(typeof handler, 'function');
  assert.deepEqual(events, [{ type: 'result', version: 1, payload: { ok: true } }]);
  assert.throws(() => W.installWorker({}), /scope\.postMessage/);
});

test('default simulation dispatch validates the view before choosing a wave solver', async () => {
  const calls = [];
  const dependencies = {
    async solveCoherent(_snapshot, hooks) {
      calls.push(['coherent', typeof hooks.yieldControl]);
      return { model: 'wave' };
    },
  };
  const hooks = { isCancelled: () => false, onProgress() {}, async yieldControl() {} };

  assert.deepEqual(
    await W.runSimulation({ analysis: { view: 'coherent' } }, hooks, dependencies),
    { model: 'wave', view: 'coherent', coherent: true },
  );
  assert.deepEqual(
    await W.runSimulation(
      { analysis: { view: 'coherent' } },
      hooks,
      { async solveCoherent() { return {}; } },
    ),
    { model: 'coherent-wave-pressure', view: 'coherent', coherent: true },
  );
  await assert.rejects(
    () => W.runSimulation({ analysis: { view: 'unknown' } }, hooks, dependencies),
    /broadband, coherent, or paths/i,
  );
  assert.deepEqual(calls, [['coherent', 'function']]);
  await assert.rejects(
    () => W.runSimulation(
      { analysis: { view: 'coherent' } },
      hooks,
      { async solveCoherent() { return null; } },
    ),
    /simulation result must be an object/i,
  );
});

test('default dispatch produces bounded reflection paths with actual ray dependencies', async () => {
  let yields = 0;
  const result = await W.runSimulation(simulationFixture('paths'), {
    isCancelled: () => false,
    onProgress() {},
    async yieldControl() { yields += 1; },
  }, numericalDependencies);

  assert.equal(result.model, 'incoherent-ray-energy');
  assert.equal(result.view, 'paths');
  assert.equal(result.coherent, false);
  assert.equal(result.reflectionBounces, 5);
  assert.ok(result.paths.some(path => path.bounces === 5));
  assert.ok(result.energy.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(yields > 0);
});

test('default dispatch combines actual wave and ray results for broadband energy', async () => {
  const result = await W.runSimulation(simulationFixture('broadband'), {
    isCancelled: () => false,
    onProgress() {},
    async yieldControl() {},
  }, numericalDependencies);

  assert.equal(result.model, 'hybrid-broadband-energy');
  assert.equal(result.view, 'broadband');
  assert.equal(result.coherent, false);
  assert.ok(result.wave.model.includes('wave'));
  assert.equal(result.ray.model, 'incoherent-ray-energy');
  assert.ok(result.energy.every(value => Number.isFinite(value) && value >= 0));
  assert.equal(result.energy.length, result.width * result.height);
  for (let index = 1; index < result.ray.bands.length; index += 1) {
    assert.ok(Math.abs(
      result.ray.bands[index].frequency / result.ray.bands[index - 1].frequency
      - 2 ** (1 / 3)
    ) < 1e-12);
  }
});

test('broadband dispatch preflights ray work before starting the wave solver', async () => {
  let waveCalls = 0;
  const dependencies = {
    ...numericalDependencies,
    preflightRayCoverage() { throw new RangeError('ray work budget exceeded'); },
    async solveBroadbandImpulse() {
      waveCalls += 1;
      return {};
    },
  };

  await assert.rejects(() => W.runSimulation(simulationFixture('broadband'), {
    isCancelled: () => false,
    onProgress() {},
    async yieldControl() {},
  }, dependencies), /ray work budget/i);

  assert.equal(waveCalls, 0);
});

test('chunked ray fallback observes cancellation at an internal ray checkpoint', async () => {
  const snapshot = simulationFixture('paths');
  snapshot.sources.push({ ...snapshot.sources[0], id: 'speaker-2', x: 1.25 });
  let cancelled = false;
  let yields = 0;

  await assert.rejects(() => W.runSimulation(snapshot, {
    isCancelled: () => cancelled,
    onProgress() {},
    async yieldControl() {
      yields += 1;
      cancelled = true;
    },
  }, numericalDependencies), /cancelled/i);

  assert.equal(yields, 1);
});

test('controller cancels the prior solve and publishes only the latest worker result', async () => {
  const events = [];
  const worker = fakeWorker();
  const controller = C.createSimulationController({
    workerFactory: () => worker,
    fallbackRunner: async () => ({}),
    onEvent: event => events.push(event),
  });
  const oldSnapshot = { id: 'old', nested: { value: 1 } };

  assert.equal(await controller.solve(oldSnapshot), 1);
  oldSnapshot.nested.value = 99;
  assert.equal(await controller.solve({ id: 'new' }), 2);
  worker.emit('message', { type: 'result', version: 1, payload: { id: 'old' } });
  worker.emit('message', { type: 'result', version: 2, payload: { id: 'new' } });

  assert.deepEqual(worker.messages, [
    { type: 'solve', version: 1, snapshot: { id: 'old', nested: { value: 1 } } },
    { type: 'cancel', version: 1 },
    { type: 'solve', version: 2, snapshot: { id: 'new' } },
  ]);
  assert.deepEqual(events.filter(event => event.type === 'result'), [
    { type: 'result', version: 2, payload: { id: 'new' } },
  ]);
});

test('worker construction failure activates a yielding immutable fallback', async () => {
  const events = [];
  let fallbackSnapshot;
  let yielded = false;
  const original = { nested: { value: 1 } };
  const controller = C.createSimulationController({
    workerFactory: () => { throw new Error('blocked'); },
    fallbackRunner: async (snapshot, version, hooks) => {
      fallbackSnapshot = snapshot;
      snapshot.nested.value = 2;
      hooks.onProgress({ phase: 'fallback', completed: 1, total: 1 });
      await hooks.yieldControl();
      yielded = true;
      return { field: true, version };
    },
    onEvent: event => events.push(event),
  });

  assert.equal(await controller.solve(original), 1);

  assert.notEqual(fallbackSnapshot, original);
  assert.equal(original.nested.value, 1);
  assert.equal(yielded, true);
  assert.deepEqual(events, [
    {
      type: 'fallback',
      reason: 'Web Worker unavailable; using responsive main-thread calculation.',
    },
    {
      type: 'progress',
      version: 1,
      payload: { phase: 'fallback', completed: 1, total: 1 },
    },
    { type: 'result', version: 1, payload: { field: true, version: 1 } },
  ]);
});

test('controller suppresses a stale fallback completion after a newer solve', async () => {
  const runs = [];
  const events = [];
  const controller = C.createSimulationController({
    workerFactory: () => { throw new Error('blocked'); },
    fallbackRunner: (_snapshot, version) => {
      const run = deferred();
      runs.push({ version, run });
      return run.promise;
    },
    onEvent: event => events.push(event),
  });

  const first = controller.solve({ id: 'old' });
  const second = controller.solve({ id: 'new' });
  runs[0].run.resolve({ id: 'old' });
  runs[1].run.resolve({ id: 'new' });
  await Promise.all([first, second]);

  assert.deepEqual(events.filter(event => event.type === 'result'), [
    { type: 'result', version: 2, payload: { id: 'new' } },
  ]);
});

test('controller debounce runs only the latest immutable scheduled snapshot', async () => {
  const worker = fakeWorker();
  const controller = C.createSimulationController({
    workerFactory: () => worker,
    fallbackRunner: async () => ({}),
    onEvent() {},
  });
  const oldSnapshot = { id: 'old' };
  const latestSnapshot = { id: 'latest', nested: { value: 1 } };

  const oldSchedule = controller.schedule(oldSnapshot, 10);
  const latestSchedule = controller.schedule(latestSnapshot, 10);
  latestSnapshot.nested.value = 5;

  assert.equal(await oldSchedule, null);
  assert.equal(await latestSchedule, 2);
  assert.deepEqual(worker.messages, [{
    type: 'solve',
    version: 2,
    snapshot: { id: 'latest', nested: { value: 1 } },
  }]);
});

test('scheduling newer state immediately rejects and cancels the active version', async () => {
  const worker = fakeWorker();
  const events = [];
  const controller = C.createSimulationController({
    workerFactory: () => worker,
    fallbackRunner: async () => ({}),
    onEvent: event => events.push(event),
  });
  await controller.solve({ id: 'old' });

  const scheduled = controller.schedule({ id: 'new' }, 20);
  worker.emit('message', { type: 'result', version: 1, payload: { id: 'old' } });

  assert.deepEqual(events.filter(event => event.type === 'result'), []);
  assert.deepEqual(worker.messages, [
    { type: 'solve', version: 1, snapshot: { id: 'old' } },
    { type: 'cancel', version: 1 },
  ]);
  controller.cancel();
  assert.equal(await scheduled, null);
});

test('worker runtime failure terminates it and retries the current solve in fallback', async () => {
  const worker = fakeWorker();
  const events = [];
  const controller = C.createSimulationController({
    workerFactory: () => worker,
    fallbackRunner: async (_snapshot, version, hooks) => {
      await hooks.yieldControl();
      return { recovered: version };
    },
    onEvent: event => events.push(event),
  });

  assert.equal(await controller.solve({ id: 'current' }), 1);
  worker.emit('error', new Error('worker crashed'));
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(worker.terminated, true);
  assert.equal(events.filter(event => event.type === 'fallback').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'result'), [
    { type: 'result', version: 1, payload: { recovered: 1 } },
  ]);
});

test('worker postMessage failure retries the solve in fallback', async () => {
  const worker = fakeWorker();
  worker.postMessage = () => { throw new Error('worker is no longer active'); };
  const events = [];
  const controller = C.createSimulationController({
    workerFactory: () => worker,
    fallbackRunner: async (_snapshot, version, hooks) => {
      await hooks.yieldControl();
      return { recovered: version };
    },
    onEvent: event => events.push(event),
  });

  assert.equal(await controller.solve({ id: 'current' }), 1);

  assert.equal(worker.terminated, true);
  assert.equal(events.filter(event => event.type === 'fallback').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'result'), [
    { type: 'result', version: 1, payload: { recovered: 1 } },
  ]);
});

test('cancel and dispose stop pending work and reject future solves', async () => {
  const worker = fakeWorker();
  const controller = C.createSimulationController({
    workerFactory: () => worker,
    fallbackRunner: async () => ({}),
    onEvent() {},
  });

  const scheduled = controller.schedule({ id: 'pending' }, 20);
  controller.cancel();
  assert.equal(await scheduled, null);
  assert.deepEqual(worker.messages, []);

  await controller.solve({ id: 'active' });
  controller.dispose();
  assert.equal(worker.terminated, true);
  assert.deepEqual(worker.messages.at(-1), { type: 'cancel', version: 3 });
  await assert.rejects(() => controller.solve({}), /disposed/i);
});

test('cancel releases a worker that rejects the cancellation message', async () => {
  const worker = fakeWorker();
  const events = [];
  const controller = C.createSimulationController({
    workerFactory: () => worker,
    fallbackRunner: async () => ({}),
    onEvent: event => events.push(event),
  });
  await controller.solve({ id: 'active' });
  worker.postMessage = () => { throw new Error('worker is no longer active'); };

  assert.doesNotThrow(() => controller.cancel());
  assert.equal(worker.terminated, true);
  assert.equal(events.filter(event => event.type === 'fallback').length, 1);
});

test('dispose still terminates a worker that rejects cancellation', async () => {
  const worker = fakeWorker();
  const controller = C.createSimulationController({
    workerFactory: () => worker,
    fallbackRunner: async () => ({}),
    onEvent() {},
  });
  await controller.solve({ id: 'active' });
  worker.postMessage = () => { throw new Error('worker is no longer active'); };

  assert.doesNotThrow(() => controller.dispose());
  assert.equal(worker.terminated, true);
  await assert.rejects(() => controller.solve({}), /disposed/i);
});

test('default inline worker construction revokes its Blob URL on dispose', () => {
  const originalWorker = globalThis.Worker;
  const originalSource = globalThis.__ROOM_WAVE_WORKER_SOURCE__;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revoked = [];
  const worker = fakeWorker();

  try {
    globalThis.__ROOM_WAVE_WORKER_SOURCE__ = 'self.postMessage({});';
    globalThis.Worker = function Worker(url) {
      assert.equal(url, 'blob:room-wave-test');
      return worker;
    };
    URL.createObjectURL = blob => {
      assert.ok(blob instanceof Blob);
      return 'blob:room-wave-test';
    };
    URL.revokeObjectURL = url => revoked.push(url);

    const controller = C.createSimulationController({
      fallbackRunner: async () => ({}),
      onEvent() {},
    });
    controller.dispose();

    assert.equal(worker.terminated, true);
    assert.deepEqual(revoked, ['blob:room-wave-test']);
  } finally {
    globalThis.Worker = originalWorker;
    globalThis.__ROOM_WAVE_WORKER_SOURCE__ = originalSource;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});
