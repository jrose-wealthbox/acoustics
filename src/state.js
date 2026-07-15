(function (root, factory) {
  const api = factory(root.RoomWave || {});
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function (RoomWave) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const numericControl = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, min, max) : fallback;
  };
  const normalizeRotation = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? ((number % 360) + 360) % 360 : fallback;
  };

  const createDefaultProject = () => ({
    schemaVersion: RoomWave.SCHEMA_VERSION,
    room: {
      cells: RoomWave.rectangleCells(10, 7),
      ceilingHeight: 2.5,
      absorption: 0.15,
    },
    sources: [],
    listeningPoint: { x: 5, y: 3.5, z: 1.2 },
    acoustics: { speedOfSound: 343 },
    analysis: {
      view: 'broadband',
      frequency: 74,
      advancedFrequency: false,
      quality: 'standard',
      mapResolution: 0.25,
    },
    ui: {
      roomEditMode: false,
      selectedSourceId: null,
      message: null,
      pan: { x: 0, y: 0 },
      zoom: 1,
    },
  });

  const normalizeSourceControls = (source, ceilingHeight, fallback = source) => {
    const next = { ...source };
    if ('z' in source) {
      next.z = numericControl(source.z, fallback.z, 0.1, ceilingHeight - 0.1);
    }
    if ('gainDb' in source) {
      next.gainDb = numericControl(source.gainDb, fallback.gainDb, -12, 6);
    }
    if ('delayMs' in source) {
      next.delayMs = numericControl(source.delayMs, fallback.delayMs, 0, 20);
    }
    if ('rotation' in source) {
      next.rotation = normalizeRotation(source.rotation, fallback.rotation);
    }
    return next;
  };

  const updateSource = (project, id, update) => {
    const index = project.sources.findIndex(source => source.id === id);
    if (index === -1) return project;

    const current = project.sources[index];
    const next = update(current);
    if (next === current) return project;

    const sources = project.sources.slice();
    sources[index] = next;
    return { ...project, sources };
  };

  const configureRoom = (project, changes) => {
    const ceilingHeight = numericControl(
      changes.ceilingHeight,
      project.room.ceilingHeight,
      2,
      10,
    );
    const absorption = numericControl(
      changes.absorption,
      project.room.absorption,
      0,
      1,
    );
    const speedOfSound = numericControl(
      changes.speedOfSound,
      project.acoustics.speedOfSound,
      300,
      360,
    );
    const maxHeight = ceilingHeight - 0.1;
    const listeningPoint = project.listeningPoint.z > maxHeight
      ? { ...project.listeningPoint, z: maxHeight }
      : project.listeningPoint;
    const sources = project.sources.map(source => (
      source.z > maxHeight ? { ...source, z: maxHeight } : source
    ));
    const sourcesChanged = sources.some((source, index) => source !== project.sources[index]);

    if (
      ceilingHeight === project.room.ceilingHeight
      && absorption === project.room.absorption
      && speedOfSound === project.acoustics.speedOfSound
      && listeningPoint === project.listeningPoint
      && !sourcesChanged
    ) return project;

    return {
      ...project,
      room: { ...project.room, ceilingHeight, absorption },
      sources: sourcesChanged ? sources : project.sources,
      listeningPoint,
      acoustics: { ...project.acoustics, speedOfSound },
    };
  };

  const reduceProject = (project, action) => {
    if (action.type === 'room/stroke') {
      const result = RoomWave.applyCellStroke(project.room.cells, action.points);
      if (result.error) {
        return { ...project, ui: { ...project.ui, message: result.error } };
      }
      if (result.cells === project.room.cells && project.ui.message === null) return project;
      return {
        ...project,
        room: { ...project.room, cells: result.cells },
        ui: { ...project.ui, message: null },
      };
    }

    if (action.type === 'source/add') {
      const source = normalizeSourceControls(
        action.source,
        project.room.ceilingHeight,
      );
      return { ...project, sources: [...project.sources, source] };
    }

    if (action.type === 'source/move') {
      return updateSource(project, action.id, source => {
        const next = normalizeSourceControls({
          ...source,
          x: action.x,
          y: action.y,
          z: action.z ?? source.z,
        }, project.room.ceilingHeight, source);
        if (next.x === source.x && next.y === source.y && next.z === source.z) return source;
        return next;
      });
    }

    if (action.type === 'source/remove') {
      if (!project.sources.some(source => source.id === action.id)) return project;
      return {
        ...project,
        sources: project.sources.filter(source => source.id !== action.id),
      };
    }

    if (action.type === 'source/configure') {
      return updateSource(project, action.id, source => {
        const next = normalizeSourceControls(
          { ...source, ...action.changes },
          project.room.ceilingHeight,
          source,
        );
        return Object.keys(next).every(key => next[key] === source[key]) ? source : next;
      });
    }

    if (action.type === 'source/rotate') {
      return updateSource(project, action.id, source => {
        const rotation = normalizeRotation((source.rotation || 0) + action.delta, source.rotation);
        return rotation === source.rotation ? source : { ...source, rotation };
      });
    }

    if (action.type === 'listening/move') {
      const listeningPoint = {
        ...project.listeningPoint,
        x: action.x,
        y: action.y,
        z: numericControl(
          action.z ?? project.listeningPoint.z,
          project.listeningPoint.z,
          0.1,
          project.room.ceilingHeight - 0.1,
        ),
      };
      if (Object.keys(listeningPoint).every(key => listeningPoint[key] === project.listeningPoint[key])) {
        return project;
      }
      return { ...project, listeningPoint };
    }

    if (action.type === 'room/configure') return configureRoom(project, action.changes || {});

    if (action.type === 'analysis/set') {
      let value = action.value;
      if (action.key === 'frequency') {
        value = numericControl(value, project.analysis.frequency, 20, 200);
      } else if (action.key === 'mapResolution') {
        value = numericControl(value, project.analysis.mapResolution, 0.1, 1);
      }
      if (project.analysis[action.key] === value) return project;
      return { ...project, analysis: { ...project.analysis, [action.key]: value } };
    }

    return project;
  };

  const createHistory = (present, limit = 50) => ({
    past: [],
    present,
    future: [],
    limit,
  });

  const appendPast = (history, present) => (
    history.limit > 0
      ? [...history.past, present].slice(-history.limit)
      : []
  );

  const dispatchHistory = (history, action) => {
    const next = reduceProject(history.present, action);
    if (next === history.present) return history;
    return {
      ...history,
      past: appendPast(history, history.present),
      present: next,
      future: [],
    };
  };

  const undo = history => (history.past.length ? {
    ...history,
    past: history.past.slice(0, -1),
    present: history.past.at(-1),
    future: [history.present, ...history.future],
  } : history);

  const redo = history => (history.future.length ? {
    ...history,
    past: appendPast(history, history.present),
    present: history.future[0],
    future: history.future.slice(1),
  } : history);

  return {
    createDefaultProject,
    reduceProject,
    createHistory,
    dispatchHistory,
    undo,
    redo,
  };
});
