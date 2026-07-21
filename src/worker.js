(function (root, factory) {
  const api = factory(root.RoomWave || {});
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function (RoomWave) {
  const requireObject = (value, name) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`${name} must be an object.`);
    }
  };
  const requireVersion = version => {
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new RangeError('message.version must be a positive safe integer.');
    }
  };
  const serializeError = error => ({
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  });
  const errorVersion = message => (
    message && Number.isSafeInteger(message.version) && message.version > 0
      ? message.version
      : 0
  );
  const rejectIfCancelled = hooks => {
    if (hooks.isCancelled()) throw new Error('Calculation cancelled.');
  };
  const requireFunction = (dependencies, name) => {
    if (typeof dependencies[name] !== 'function') {
      throw new Error(`${name} is unavailable.`);
    }
    return dependencies[name];
  };
  const withRayWalls = (snapshot, dependencies) => {
    if (Array.isArray(snapshot.room?.walls)) return snapshot;
    if (!(snapshot.room?.cells instanceof Set)) {
      throw new TypeError('snapshot.room must provide walls or Set cells for ray analysis.');
    }
    const extractWallSegments = requireFunction(dependencies, 'extractWallSegments');
    return {
      ...snapshot,
      room: { ...snapshot.room, walls: extractWallSegments(snapshot.room.cells) },
    };
  };
  const logarithmicBands = (snapshot, dependencies) => {
    if (!Array.isArray(snapshot.sources) || snapshot.sources.length === 0) {
      throw new TypeError('snapshot.sources must be a nonempty array for broadband analysis.');
    }
    requireObject(dependencies.SOURCE_TYPES, 'dependencies.SOURCE_TYPES');
    const minimum = 20;
    let maximum = -Infinity;
    snapshot.sources.forEach((source, index) => {
      requireObject(source, `snapshot.sources[${index}]`);
      const definition = dependencies.SOURCE_TYPES[source.type];
      if (!definition) throw new RangeError(`snapshot.sources[${index}].type must match the source catalog.`);
      maximum = Math.max(maximum, definition.maxHz);
    });
    const ratio = 2 ** (1 / 3);
    const bands = [];
    for (let frequency = minimum; frequency <= maximum; frequency *= ratio) {
      bands.push(frequency);
      if (bands.length > 128) throw new RangeError('Broadband frequency count cannot exceed 128.');
    }
    return bands;
  };

  const runChunkedRayCoverage = async (
    snapshot,
    frequencies,
    hooks,
    dependencies,
    validatedPlan,
  ) => {
    const accumulateRayCoverageAsync = requireFunction(
      dependencies,
      'accumulateRayCoverageAsync',
    );
    return accumulateRayCoverageAsync(snapshot, frequencies, hooks, validatedPlan);
  };

  const runBroadband = async (snapshot, hooks, dependencies) => {
    const solveBroadbandImpulse = requireFunction(dependencies, 'solveBroadbandImpulse');
    const resampleMap = requireFunction(dependencies, 'resampleMap');
    const combineBroadbandBands = requireFunction(dependencies, 'combineBroadbandBands');
    const raySnapshot = withRayWalls(snapshot, dependencies);
    const frequencies = logarithmicBands(snapshot, dependencies);
    const rayPlan = requireFunction(dependencies, 'preflightRayCoverage')(
      raySnapshot,
      frequencies,
    );
    const wave = await solveBroadbandImpulse(snapshot, hooks);
    rejectIfCancelled(hooks);
    const ray = await runChunkedRayCoverage(
      raySnapshot,
      frequencies,
      hooks,
      dependencies,
      rayPlan,
    );
    rejectIfCancelled(hooks);
    const waveMap = resampleMap(wave, snapshot.analysis.mapResolution);
    const overlap = {
      startHz: Math.max(20, wave.reliableHz * 0.75),
      endHz: wave.reliableHz,
    };
    const bands = ray.bands.map(band => ({
      frequency: band.frequency,
      waveEnergy: waveMap.energy,
      rayEnergy: band.energy,
      overlap,
      weight: 1,
    }));
    const energy = combineBroadbandBands(bands);
    return {
      ...ray,
      model: 'hybrid-broadband-energy',
      energy,
      bands,
      wave: { ...waveMap, model: 'wave-energy' },
      ray,
      overlap,
    };
  };

  const runSimulation = async (snapshot, hooks, dependencies = RoomWave) => {
    requireObject(snapshot, 'snapshot');
    requireObject(snapshot.analysis, 'snapshot.analysis');
    requireObject(hooks, 'hooks');
    for (const name of ['isCancelled', 'onProgress', 'yieldControl']) {
      if (typeof hooks[name] !== 'function') {
        throw new TypeError(`hooks.${name} must be a function.`);
      }
    }

    if (snapshot.analysis.view === 'coherent') {
      if (typeof dependencies.solveCoherent !== 'function') {
        throw new Error('Coherent wave solver is unavailable.');
      }
      return dependencies.solveCoherent(snapshot, hooks);
    }
    if (snapshot.analysis.view === 'broadband') {
      return runBroadband(snapshot, hooks, dependencies);
    }
    if (snapshot.analysis.view === 'paths') {
      const raySnapshot = withRayWalls(snapshot, dependencies);
      return runChunkedRayCoverage(
        raySnapshot,
        [snapshot.analysis.frequency],
        hooks,
        dependencies,
      );
    }
    throw new RangeError('snapshot.analysis.view must be broadband, coherent, or paths.');
  };

  const createProtocolHandler = (dependencies, postMessage) => {
    requireObject(dependencies, 'dependencies');
    if (typeof dependencies.runSimulation !== 'function') {
      throw new TypeError('dependencies.runSimulation must be a function.');
    }
    if (typeof postMessage !== 'function') {
      throw new TypeError('postMessage must be a function.');
    }

    const cancelledVersions = new Set();
    const activeVersions = new Set();
    let highestSolveVersion = 0;

    return async message => {
      try {
        requireObject(message, 'message');
        requireVersion(message.version);
        if (message.type === 'cancel') {
          if (activeVersions.has(message.version)) cancelledVersions.add(message.version);
          return;
        }
        if (message.type !== 'solve') {
          throw new RangeError('message.type must be solve or cancel.');
        }
        if (message.version <= highestSolveVersion) {
          throw new RangeError('solve message.version must increase monotonically.');
        }
        requireObject(message.snapshot, 'message.snapshot');
        const snapshot = structuredClone(message.snapshot);
        highestSolveVersion = message.version;
        activeVersions.add(message.version);

        const hooks = {
          isCancelled: () => cancelledVersions.has(message.version),
          onProgress(payload) {
            if (!cancelledVersions.has(message.version)) {
              postMessage({ type: 'progress', version: message.version, payload });
            }
          },
          // A zero-delay task lets the worker process a queued cancel message between solver slices.
          yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)),
        };

        try {
          const payload = await dependencies.runSimulation(snapshot, hooks);
          if (hooks.isCancelled()) postMessage({ type: 'cancelled', version: message.version });
          else postMessage({ type: 'result', version: message.version, payload });
        } catch (error) {
          if (hooks.isCancelled()) {
            postMessage({ type: 'cancelled', version: message.version });
          } else {
            postMessage({ type: 'error', version: message.version, payload: serializeError(error) });
          }
        } finally {
          activeVersions.delete(message.version);
          cancelledVersions.delete(message.version);
        }
      } catch (error) {
        postMessage({ type: 'error', version: errorVersion(message), payload: serializeError(error) });
      }
    };
  };

  const installWorker = scope => {
    requireObject(scope, 'scope');
    if (typeof scope.postMessage !== 'function') {
      throw new TypeError('scope.postMessage must be a function.');
    }
    if (typeof scope.addEventListener !== 'function') {
      throw new TypeError('scope.addEventListener must be a function.');
    }
    requireObject(scope.RoomWave, 'scope.RoomWave');
    const handler = createProtocolHandler(
      scope.RoomWave,
      scope.postMessage.bind(scope),
    );
    scope.addEventListener('message', event => handler(event.data));
    return handler;
  };

  return {
    createProtocolHandler,
    installWorker,
    runChunkedRayCoverage,
    runSimulation,
  };
});
