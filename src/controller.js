(function (root, factory) {
  const api = factory(root.RoomWave || {});
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function (RoomWave) {
  const FALLBACK_REASON = 'Web Worker unavailable; using responsive main-thread calculation.';
  const RESULT_EVENT_TYPES = new Set(['progress', 'result', 'error', 'cancelled']);

  const requireObject = (value, name) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`${name} must be an object.`);
    }
  };
  const serializeError = error => ({
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  });
  const cloneSnapshot = snapshot => {
    requireObject(snapshot, 'snapshot');
    return structuredClone(snapshot);
  };
  const validateWorker = candidate => {
    requireObject(candidate, 'worker');
    for (const name of ['postMessage', 'addEventListener', 'terminate']) {
      if (typeof candidate[name] !== 'function') {
        throw new TypeError(`worker.${name} must be a function.`);
      }
    }
    return candidate;
  };
  const createInlineWorker = () => {
    if (typeof globalThis.__ROOM_WAVE_WORKER_SOURCE__ !== 'string') {
      throw new Error('Inline worker source is unavailable.');
    }
    if (
      typeof Blob !== 'function'
      || typeof Worker !== 'function'
      || typeof URL?.createObjectURL !== 'function'
      || typeof URL?.revokeObjectURL !== 'function'
    ) throw new Error('Inline Web Worker APIs are unavailable.');

    const url = URL.createObjectURL(new Blob(
      [globalThis.__ROOM_WAVE_WORKER_SOURCE__],
      { type: 'text/javascript' },
    ));
    try {
      return { worker: new Worker(url), url };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  };
  const validWorkerEvent = event => (
    typeof event === 'object'
    && event !== null
    && RESULT_EVENT_TYPES.has(event.type)
    && Number.isSafeInteger(event.version)
    && event.version > 0
  );

  const createSimulationController = options => {
    requireObject(options, 'options');
    const { workerFactory, onEvent } = options;
    if (workerFactory !== undefined && typeof workerFactory !== 'function') {
      throw new TypeError('workerFactory must be a function.');
    }
    if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function.');
    const fallbackRunner = options.fallbackRunner ?? (
      (snapshot, _version, hooks) => RoomWave.runSimulation(snapshot, hooks)
    );
    if (typeof fallbackRunner !== 'function') {
      throw new TypeError('fallbackRunner must be a function.');
    }

    let version = 0;
    let worker = null;
    let workerUrl = null;
    let disposed = false;
    let fallbackAnnounced = false;
    let activeSnapshot = null;
    let activeVersion = 0;
    let pendingSchedule = null;

    const revokeWorkerUrl = () => {
      if (workerUrl !== null) {
        URL.revokeObjectURL(workerUrl);
        workerUrl = null;
      }
    };
    const announceFallback = () => {
      if (fallbackAnnounced) return;
      fallbackAnnounced = true;
      onEvent({ type: 'fallback', reason: FALLBACK_REASON });
    };
    const releaseWorker = () => {
      if (worker) worker.terminate();
      worker = null;
      activeVersion = 0;
      revokeWorkerUrl();
    };

    const runFallback = async (snapshot, current) => {
      activeVersion = current;
      const hooks = {
        isCancelled: () => disposed || current !== version,
        onProgress(payload) {
          if (!disposed && current === version) {
            onEvent({ type: 'progress', version: current, payload });
          }
        },
        // Wave solvers checkpoint through this hook, preventing the fallback from monopolizing UI.
        yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)),
      };
      try {
        const payload = await fallbackRunner(snapshot, current, hooks);
        if (!hooks.isCancelled()) onEvent({ type: 'result', version: current, payload });
      } catch (error) {
        if (!hooks.isCancelled()) {
          onEvent({ type: 'error', version: current, payload: serializeError(error) });
        }
      } finally {
        if (current === version) {
          activeSnapshot = null;
          activeVersion = 0;
        }
      }
      return current;
    };

    const activateFallback = async () => {
      if (!worker) return;
      const snapshot = activeSnapshot;
      const current = activeVersion;
      releaseWorker();
      announceFallback();
      if (snapshot && current === version && !disposed) await runFallback(snapshot, current);
    };

    try {
      const created = workerFactory ? workerFactory() : createInlineWorker();
      if (created && typeof created === 'object' && 'worker' in created) {
        worker = validateWorker(created.worker);
        workerUrl = created.url ?? null;
      } else {
        worker = validateWorker(created);
      }
      worker.addEventListener('message', ({ data }) => {
        if (!validWorkerEvent(data) || data.version !== version || disposed) return;
        onEvent(data);
        if (data.type === 'result' || data.type === 'error' || data.type === 'cancelled') {
          activeSnapshot = null;
          activeVersion = 0;
        }
      });
      worker.addEventListener('error', () => { void activateFallback(); });
    } catch (_error) {
      releaseWorker();
      announceFallback();
    }

    const solvePrepared = async (snapshot, current) => {
      if (disposed) throw new Error('Simulation controller is disposed.');
      const previous = activeVersion;
      activeSnapshot = snapshot;
      activeVersion = current;
      if (worker) {
        try {
          if (previous > 0) worker.postMessage({ type: 'cancel', version: previous });
          worker.postMessage({ type: 'solve', version: current, snapshot });
        } catch (_error) {
          await activateFallback();
        }
        return current;
      }
      return runFallback(snapshot, current);
    };

    const clearSchedule = () => {
      if (!pendingSchedule) return;
      clearTimeout(pendingSchedule.timer);
      pendingSchedule.resolve(null);
      pendingSchedule = null;
    };

    return {
      solve(snapshot) {
        if (disposed) return Promise.reject(new Error('Simulation controller is disposed.'));
        clearSchedule();
        const prepared = cloneSnapshot(snapshot);
        const current = ++version;
        return solvePrepared(prepared, current);
      },
      schedule(snapshot, delay = 180) {
        if (disposed) return Promise.reject(new Error('Simulation controller is disposed.'));
        if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 60000) {
          return Promise.reject(new RangeError('delay must be between 0 and 60000 ms.'));
        }
        const prepared = cloneSnapshot(snapshot);
        clearSchedule();
        const previous = activeVersion;
        const current = ++version;
        activeSnapshot = null;
        activeVersion = 0;
        if (worker && previous > 0) {
          try {
            worker.postMessage({ type: 'cancel', version: previous });
          } catch (_error) {
            releaseWorker();
            announceFallback();
          }
        }
        return new Promise(resolve => {
          const timer = setTimeout(() => {
            pendingSchedule = null;
            void solvePrepared(prepared, current).then(resolve);
          }, delay);
          pendingSchedule = { timer, resolve };
        });
      },
      cancel() {
        if (disposed) return;
        clearSchedule();
        const current = activeVersion;
        version += 1;
        activeSnapshot = null;
        activeVersion = 0;
        if (worker && current > 0) {
          try {
            worker.postMessage({ type: 'cancel', version: current });
          } catch (_error) {
            releaseWorker();
            announceFallback();
          }
        }
      },
      dispose() {
        if (disposed) return;
        clearSchedule();
        const current = activeVersion;
        version += 1;
        activeSnapshot = null;
        activeVersion = 0;
        if (worker && current > 0) {
          try {
            worker.postMessage({ type: 'cancel', version: current });
          } catch (_error) {
            // Disposal must continue through termination and Blob URL cleanup.
          }
        }
        disposed = true;
        releaseWorker();
      },
    };
  };

  return { createSimulationController };
});
