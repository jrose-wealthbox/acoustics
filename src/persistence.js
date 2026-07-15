(function (root, factory) {
  const api = factory(root.RoomWave || {});
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function (RoomWave) {
  const STORAGE_KEYS = Object.freeze({
    rooms: 'room-wave:rooms:v1',
    projects: 'room-wave:projects:v1',
  });
  const ANALYSIS_DOMAINS = Object.freeze({
    quality: Object.freeze(['fast', 'standard', 'high']),
    mapResolution: Object.freeze([0.1, 0.25, 0.5, 1]),
    view: Object.freeze(['broadband', 'coherent', 'paths']),
  });
  const MAX_ROOM_SPAN = 30;
  const MAX_ROOM_CELLS = MAX_ROOM_SPAN * MAX_ROOM_SPAN;
  const MAX_GRID_COORDINATE = Number.MAX_SAFE_INTEGER - MAX_ROOM_SPAN;

  const errorMessage = error => {
    try {
      return typeof error?.message === 'string' ? error.message : String(error);
    } catch (_) {
      return 'Unknown persistence error.';
    }
  };

  const cellObjects = cells => [...cells].map(key => {
    const [x, y] = key.split(',').map(Number);
    return { x, y };
  }).sort((left, right) => left.y - right.y || left.x - right.x);

  const persistentSource = source => ({
    id: source.id,
    type: source.type,
    x: source.x,
    y: source.y,
    z: source.z,
    gainDb: source.gainDb,
    delayMs: source.delayMs,
    polarity: source.polarity,
    rotation: source.rotation,
  });

  const persistentAnalysis = analysis => {
    const result = {
      quality: analysis.quality,
      mapResolution: analysis.mapResolution,
      frequency: analysis.frequency,
      view: analysis.view,
    };
    if (Object.hasOwn(analysis, 'advancedFrequency')) {
      result.advancedFrequency = analysis.advancedFrequency;
    }
    return result;
  };

  const projectToDocument = project => JSON.stringify({
    schemaVersion: project.schemaVersion,
    room: {
      cells: cellObjects(project.room.cells),
      ceilingHeight: project.room.ceilingHeight,
      absorption: project.room.absorption,
    },
    sources: project.sources.map(persistentSource),
    listeningPoint: {
      x: project.listeningPoint.x,
      y: project.listeningPoint.y,
      z: project.listeningPoint.z,
    },
    acoustics: { speedOfSound: project.acoustics.speedOfSound },
    analysis: persistentAnalysis(project.analysis),
  }, null, 2);

  const reject = message => {
    throw new Error(message);
  };

  const requireRecord = (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      reject(`${path} must be an object.`);
    }
  };

  const requireKeys = (value, path, required, optional = []) => {
    requireRecord(value, path);
    const allowed = new Set([...required, ...optional]);
    const unexpected = Object.keys(value).find(key => !allowed.has(key));
    if (unexpected !== undefined) reject(`${path}.${unexpected} is not supported.`);
    const missing = required.find(key => !Object.hasOwn(value, key));
    if (missing !== undefined) reject(`${path}.${missing} is required.`);
  };

  const requireNumber = (value, path, min, max, options = {}) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      reject(`${path} must be a finite number.`);
    }
    if (options.integer && !Number.isInteger(value)) reject(`${path} must be an integer.`);
    const aboveMaximum = options.maximumExclusive ? value >= max : value > max;
    if (value < min || aboveMaximum) {
      const separator = options.maximumExclusive ? 'less than' : 'at most';
      reject(`${path} must be at least ${min} and ${separator} ${max}.`);
    }
    return value;
  };

  const requireDomain = (value, path, domain) => {
    if (!domain.includes(value)) reject(`${path} is not supported.`);
    return value;
  };

  const requireGridCoordinate = (value, path) => {
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_GRID_COORDINATE) {
      reject(
        `${path} must be a safe integer grid coordinate with ${MAX_ROOM_SPAN} cells of arithmetic headroom.`,
      );
    }
    return value;
  };

  const parseCells = room => {
    if (!Array.isArray(room.cells) || room.cells.length === 0) {
      reject('room.cells must be a nonempty array.');
    }
    if (room.cells.length > MAX_ROOM_CELLS) {
      reject(`room.cells cannot contain more than ${MAX_ROOM_CELLS} cells.`);
    }

    const cells = new Set();
    for (let index = 0; index < room.cells.length; index += 1) {
      const cell = room.cells[index];
      const path = `room.cells[${index}]`;
      requireKeys(cell, path, ['x', 'y']);
      // Version 1 cell coordinates are absolute world-grid indices relative to a fixed (0, 0)
      // origin. There is deliberately no separately mutable or persisted grid-origin field.
      const x = requireGridCoordinate(cell.x, `${path}.x`);
      const y = requireGridCoordinate(cell.y, `${path}.y`);
      const key = `${x},${y}`;
      if (cells.has(key)) reject(`${path} duplicates another room cell.`);
      cells.add(key);
    }

    const coordinates = [...cells].map(key => key.split(',').map(Number));
    const xs = coordinates.map(([x]) => x);
    const ys = coordinates.map(([, y]) => y);
    const width = Math.max(...xs) - Math.min(...xs) + 1;
    const height = Math.max(...ys) - Math.min(...ys) + 1;
    if (width > MAX_ROOM_SPAN || height > MAX_ROOM_SPAN) {
      reject('room.cells cannot exceed a 30 × 30 m bounding box.');
    }

    const topology = RoomWave.analyzeTopology(cells);
    if (!topology.connected) reject('room.cells must form one connected room.');
    if (topology.hasHole) reject('room.cells cannot contain an enclosed hole.');
    return cells;
  };

  const requirePosition = (value, path, cells, ceilingHeight) => {
    const x = requireNumber(value.x, `${path}.x`, -Infinity, Infinity);
    const y = requireNumber(value.y, `${path}.y`, -Infinity, Infinity);
    const z = requireNumber(value.z, `${path}.z`, 0.1, ceilingHeight - 0.1);
    if (!cells.has(`${Math.floor(x)},${Math.floor(y)}`)) {
      reject(`${path} position must be inside an occupied room cell.`);
    }
    return { x, y, z };
  };

  const parseSource = (source, index, cells, ceilingHeight, acceptedSources, ids) => {
    const path = `sources[${index}]`;
    requireKeys(source, path, [
      'id', 'type', 'x', 'y', 'z', 'gainDb', 'delayMs', 'polarity', 'rotation',
    ]);

    if (
      typeof source.id !== 'string'
      || source.id.length === 0
      || source.id !== source.id.trim()
    ) reject(`${path}.id must be a nonempty string without surrounding whitespace.`);
    if (ids.has(source.id)) reject('Source IDs must be unique.');
    if (
      typeof source.type !== 'string'
      || !RoomWave.SOURCE_TYPES
      || !Object.hasOwn(RoomWave.SOURCE_TYPES, source.type)
    ) reject(`${path}.type must match the source catalog.`);

    const allowed = RoomWave.canAddSource(acceptedSources, source.type);
    if (!allowed.ok) reject(allowed.error);

    const position = requirePosition(source, path, cells, ceilingHeight);
    const gainDb = requireNumber(source.gainDb, `${path}.gainDb`, -12, 6);
    const delayMs = requireNumber(source.delayMs, `${path}.delayMs`, 0, 20);
    const polarity = requireDomain(source.polarity, `${path}.polarity`, ['normal', 'inverted']);
    const rotation = requireNumber(source.rotation, `${path}.rotation`, 0, 360, {
      maximumExclusive: true,
    });

    ids.add(source.id);
    return {
      id: source.id,
      type: source.type,
      ...position,
      gainDb,
      delayMs,
      polarity,
      rotation,
    };
  };

  const validateProject = document => {
    requireRecord(document, 'project');
    if (!Object.hasOwn(document, 'schemaVersion')) reject('project.schemaVersion is required.');
    if (typeof document.schemaVersion !== 'number' || !Number.isInteger(document.schemaVersion)) {
      reject('project.schemaVersion must be an integer.');
    }
    if (document.schemaVersion !== RoomWave.SCHEMA_VERSION) {
      reject(`Unsupported schema version ${String(document.schemaVersion)}.`);
    }
    requireKeys(document, 'project', [
      'schemaVersion', 'room', 'sources', 'listeningPoint', 'acoustics', 'analysis',
    ]);

    requireKeys(document.room, 'room', ['cells', 'ceilingHeight', 'absorption']);
    const ceilingHeight = requireNumber(
      document.room.ceilingHeight,
      'room.ceilingHeight',
      2,
      10,
    );
    const absorption = requireNumber(document.room.absorption, 'room.absorption', 0, 1);
    const cells = parseCells(document.room);

    if (!Array.isArray(document.sources)) reject('sources must be an array.');
    const acceptedSources = [];
    const ids = new Set();
    for (let index = 0; index < document.sources.length; index += 1) {
      acceptedSources.push(parseSource(
        document.sources[index],
        index,
        cells,
        ceilingHeight,
        acceptedSources,
        ids,
      ));
    }

    requireKeys(document.listeningPoint, 'listeningPoint', ['x', 'y', 'z']);
    const listeningPoint = requirePosition(
      document.listeningPoint,
      'listeningPoint',
      cells,
      ceilingHeight,
    );

    requireKeys(document.acoustics, 'acoustics', ['speedOfSound']);
    const speedOfSound = requireNumber(
      document.acoustics.speedOfSound,
      'acoustics.speedOfSound',
      300,
      360,
    );

    requireKeys(
      document.analysis,
      'analysis',
      ['quality', 'mapResolution', 'frequency', 'view'],
      ['advancedFrequency'],
    );
    const analysis = {
      quality: requireDomain(
        document.analysis.quality,
        'analysis.quality',
        ANALYSIS_DOMAINS.quality,
      ),
      mapResolution: requireDomain(
        document.analysis.mapResolution,
        'analysis.mapResolution',
        ANALYSIS_DOMAINS.mapResolution,
      ),
      frequency: requireNumber(document.analysis.frequency, 'analysis.frequency', 20, 200),
      view: requireDomain(document.analysis.view, 'analysis.view', ANALYSIS_DOMAINS.view),
    };
    if (Object.hasOwn(document.analysis, 'advancedFrequency')) {
      if (typeof document.analysis.advancedFrequency !== 'boolean') {
        reject('analysis.advancedFrequency must be a boolean.');
      }
      analysis.advancedFrequency = document.analysis.advancedFrequency;
    }

    // Construct only the validated persistent fields, preventing imported UI or prototype data
    // from entering the authoritative project state.
    return {
      schemaVersion: RoomWave.SCHEMA_VERSION,
      room: { cells, ceilingHeight, absorption },
      sources: acceptedSources,
      listeningPoint,
      acoustics: { speedOfSound },
      analysis,
    };
  };

  const parseProjectDocument = text => {
    let document;
    try {
      if (typeof text !== 'string') reject('Project JSON must be provided as text.');
      document = JSON.parse(text);
    } catch (error) {
      return { project: null, error: `Invalid project JSON: ${errorMessage(error)}` };
    }

    try {
      return { project: validateProject(document), error: null };
    } catch (error) {
      return { project: null, error: errorMessage(error) };
    }
  };

  const roomPresetFromProject = (project, name) => ({
    name,
    cells: cellObjects(project.room.cells),
    ceilingHeight: project.room.ceilingHeight,
    absorption: project.room.absorption,
  });

  const resolveStorageKey = collection => {
    if (typeof collection !== 'string') return null;
    if (Object.hasOwn(STORAGE_KEYS, collection)) return STORAGE_KEYS[collection];
    return Object.values(STORAGE_KEYS).includes(collection) ? collection : null;
  };

  const createStorage = adapter => ({
    load(collection) {
      const key = resolveStorageKey(collection);
      if (!key) {
        return { ok: false, value: null, error: 'Unknown storage collection.' };
      }
      try {
        const stored = adapter.getItem(key);
        return {
          ok: true,
          value: stored === null ? [] : JSON.parse(stored),
          error: null,
        };
      } catch (error) {
        return { ok: false, value: null, error: errorMessage(error) };
      }
    },
    save(collection, value) {
      const key = resolveStorageKey(collection);
      if (!key) {
        return { ok: false, value: null, error: 'Unknown storage collection.' };
      }
      try {
        adapter.setItem(key, JSON.stringify(value));
        return { ok: true, value, error: null };
      } catch (error) {
        return { ok: false, value: null, error: errorMessage(error) };
      }
    },
  });

  return {
    STORAGE_KEYS,
    ROOMS_STORAGE_KEY: STORAGE_KEYS.rooms,
    PROJECTS_STORAGE_KEY: STORAGE_KEYS.projects,
    projectToDocument,
    parseProjectDocument,
    roomPresetFromProject,
    createStorage,
  };
});
