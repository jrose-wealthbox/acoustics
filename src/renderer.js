(function (root, factory) {
  const dependencies = (
    typeof module !== 'undefined' && module.exports
      ? {
        ...require('./geometry.js'),
        ...require('./sources.js'),
        ...require('./analysis.js'),
      }
      : (root.RoomWave || {})
  );
  const api = factory(dependencies);
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function (RoomWave) {
  const LAYER_ORDER = Object.freeze([
    'blueprint',
    'room',
    'field',
    'grid',
    'walls',
    'contours',
    'paths',
    'sourceCones',
    'sources',
    'listeningPoint',
    'legend',
  ]);
  const VIEW_NAMES = new Set(['broadband', 'coherent', 'paths']);
  const MAX_CANVAS_PIXELS = 16_777_216;
  const MAX_CANVAS_DIMENSION = 16_384;
  const MAX_ROOM_CELLS = 900;
  const MAX_GRID_COORDINATE = Number.MAX_SAFE_INTEGER - 30;
  const MAX_SOURCES = 14;
  const MAX_PATHS = 4096;
  const MAX_PATH_POINTS = 7;
  const MAX_CONTOUR_SEGMENTS = 200_000;
  const MAX_ZOOM = 100;
  const MAX_PAN = 1_000_000;
  const PADDING = 40;
  const COHERENT_FLOOR_DB = -30;
  const metadataCache = new WeakMap();

  const PALETTES = Object.freeze({
    broadband: Object.freeze(['#071b2f', '#155e75', '#2dd4bf', '#fde68a']),
    paths: Object.freeze(['#071b2f', '#155e75', '#2dd4bf', '#fde68a']),
    coherent: Object.freeze(['#2563eb', '#e2e8f0', '#fb923c']),
  });

  const requireObject = (value, name) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`${name} must be an object.`);
    }
  };
  const requireFiniteNumber = (value, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`${name} must be a finite number.`);
    }
  };
  const requirePoint = (value, name) => {
    requireObject(value, name);
    requireFiniteNumber(value.x, `${name}.x`);
    requireFiniteNumber(value.y, `${name}.y`);
  };
  const requireView = (view, name) => {
    if (!VIEW_NAMES.has(view)) {
      throw new RangeError(`${name} must be broadband, coherent, or paths.`);
    }
  };
  const clamp = value => Math.min(1, Math.max(0, value));
  const hexToRgb = hex => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const componentHex = value => Math.round(value).toString(16).padStart(2, '0');
  const interpolateColor = (palette, value) => {
    const position = clamp(value) * (palette.length - 1);
    const left = Math.min(palette.length - 2, Math.floor(position));
    const ratio = position - left;
    const start = hexToRgb(palette[left]);
    const end = hexToRgb(palette[left + 1]);
    return `#${start.map((component, index) => (
      componentHex(component + (end[index] - component) * ratio)
    )).join('')}`;
  };
  const paletteTables = Object.freeze(Object.fromEntries(
    Object.entries(PALETTES).map(([view, palette]) => [
      view,
      Object.freeze(Array.from({ length: 256 }, (_, index) => (
        interpolateColor(palette, index / 255)
      ))),
    ]),
  ));

  const fieldColor = (view, normalizedValue) => {
    requireView(view, 'view');
    requireFiniteNumber(normalizedValue, 'normalizedValue');
    return paletteTables[view][Math.round(clamp(normalizedValue) * 255)];
  };

  const validateViewport = viewport => {
    requireObject(viewport, 'viewport');
    requireFiniteNumber(viewport.width, 'viewport.width');
    requireFiniteNumber(viewport.height, 'viewport.height');
    requireFiniteNumber(viewport.dpr, 'viewport device pixel ratio');
    if (viewport.width <= PADDING * 2) {
      throw new RangeError('Viewport drawable width must be greater than 80 CSS pixels.');
    }
    if (viewport.height <= PADDING * 2) {
      throw new RangeError('Viewport drawable height must be greater than 80 CSS pixels.');
    }
    if (viewport.dpr < 0.25 || viewport.dpr > 8) {
      throw new RangeError('Viewport device pixel ratio must be between 0.25 and 8.');
    }
    const backingWidth = Math.ceil(viewport.width * viewport.dpr);
    const backingHeight = Math.ceil(viewport.height * viewport.dpr);
    if (!Number.isSafeInteger(backingWidth) || !Number.isSafeInteger(backingHeight)) {
      throw new RangeError('Canvas backing store dimensions must be safe integers.');
    }
    if (backingWidth > MAX_CANVAS_DIMENSION || backingHeight > MAX_CANVAS_DIMENSION) {
      throw new RangeError('Canvas backing dimension exceeds 16,384 pixels.');
    }
    const backingPixels = backingWidth * backingHeight;
    if (!Number.isSafeInteger(backingPixels) || backingPixels > MAX_CANVAS_PIXELS) {
      throw new RangeError('Canvas backing store exceeds its pixel budget.');
    }
    return {
      width: viewport.width,
      height: viewport.height,
      dpr: viewport.dpr,
      backingWidth,
      backingHeight,
    };
  };

  const validateCells = cells => {
    if (!(cells instanceof Set)) throw new TypeError('state.room.cells must be a Set.');
    if (cells.size > MAX_ROOM_CELLS) {
      throw new RangeError(`state.room.cells cannot contain more than ${MAX_ROOM_CELLS} room cells.`);
    }
    const parsed = [];
    for (const key of cells) {
      if (typeof key !== 'string' || !/^-?\d+,-?\d+$/.test(key)) {
        throw new TypeError('Each room cell must use an integer "x,y" key.');
      }
      const [x, y] = key.split(',').map(Number);
      if (
        !Number.isSafeInteger(x)
        || !Number.isSafeInteger(y)
        || Math.abs(x) > MAX_GRID_COORDINATE
        || Math.abs(y) > MAX_GRID_COORDINATE
      ) throw new RangeError('Each room cell coordinate must be a safe grid integer.');
      if (key !== `${x},${y}`) {
        throw new TypeError('Each room cell must use a canonical integer "x,y" key.');
      }
      parsed.push({ key, x, y });
    }
    parsed.sort((left, right) => left.y - right.y || left.x - right.x);
    if (parsed.length > 0) {
      const minX = Math.min(...parsed.map(cell => cell.x));
      const minY = Math.min(...parsed.map(cell => cell.y));
      const maxX = Math.max(...parsed.map(cell => cell.x));
      const maxY = Math.max(...parsed.map(cell => cell.y));
      if (maxX - minX + 1 > 30 || maxY - minY + 1 > 30) {
        throw new RangeError('Room cell span cannot exceed 30 × 30 m.');
      }
    }
    return parsed;
  };

  const validateState = state => {
    requireObject(state, 'state');
    requireObject(state.room, 'state.room');
    requireObject(state.analysis, 'state.analysis');
    requireObject(state.ui, 'state.ui');
    requireObject(state.ui.pan, 'state.ui.pan');
    requireView(state.analysis.view, 'state.analysis.view');
    requireFiniteNumber(state.ui.zoom, 'state.ui.zoom');
    if (state.ui.zoom <= 0 || state.ui.zoom > MAX_ZOOM) {
      throw new RangeError('state.ui.zoom must be greater than zero and no greater than 100.');
    }
    for (const component of ['x', 'y']) {
      requireFiniteNumber(state.ui.pan[component], `state.ui.pan.${component}`);
      if (Math.abs(state.ui.pan[component]) > MAX_PAN) {
        throw new RangeError('state.ui.pan components must be within 1,000,000 CSS pixels.');
      }
    }
    if (!Array.isArray(state.sources)) throw new TypeError('state.sources must be an array.');
    if (state.sources.length > MAX_SOURCES) {
      throw new RangeError(`state.sources cannot contain more than ${MAX_SOURCES} entries.`);
    }
    const sources = state.sources.map((source, index) => {
      requireObject(source, `state.sources[${index}]`);
      if (typeof source.id !== 'string' || source.id.length === 0) {
        throw new TypeError(`state.sources[${index}].id must be a nonempty string.`);
      }
      if (typeof source.type !== 'string' || !RoomWave.SOURCE_TYPES?.[source.type]) {
        throw new RangeError(`state.sources[${index}].type must match the source catalog.`);
      }
      requirePoint(source, `state.sources[${index}]`);
      const rotation = source.rotation ?? 0;
      requireFiniteNumber(rotation, `state.sources[${index}].rotation`);
      return { source, rotation };
    });
    requirePoint(state.listeningPoint, 'state.listeningPoint');
    return { cells: validateCells(state.room.cells), sources };
  };

  const contourLevels = Object.freeze(Array.from(
    { length: Math.abs(COHERENT_FLOOR_DB) / 3 },
    (_, index) => COHERENT_FLOOR_DB + index * 3,
  ));
  const edgeIntersection = (level, first, second) => {
    const crosses = (first.value < level && second.value >= level)
      || (first.value >= level && second.value < level);
    if (!crosses || first.value === second.value) return null;
    const ratio = (level - first.value) / (second.value - first.value);
    return {
      x: first.x + (second.x - first.x) * ratio,
      y: first.y + (second.y - first.y) * ratio,
    };
  };
  const buildContours = (result, metadata) => {
    if (result.view !== 'coherent' || metadata.width < 2 || metadata.height < 2) {
      return { segments: [], limited: false };
    }
    const segments = [];
    let limited = false;
    const inside = result.inside;
    outer: for (let y = 0; y < metadata.height - 1; y += 1) {
      for (let x = 0; x < metadata.width - 1; x += 1) {
        const indices = [
          y * metadata.width + x,
          y * metadata.width + x + 1,
          (y + 1) * metadata.width + x + 1,
          (y + 1) * metadata.width + x,
        ];
        if (inside && indices.some(index => !inside[index])) continue;
        const points = indices.map((index, corner) => ({
          value: result.levelDb[index],
          x: metadata.sampleMinX + (x + (corner === 1 || corner === 2 ? 1 : 0)) * metadata.spacing,
          y: metadata.sampleMinY + (y + (corner >= 2 ? 1 : 0)) * metadata.spacing,
        }));
        for (const level of contourLevels) {
          const crossings = [
            edgeIntersection(level, points[0], points[1]),
            edgeIntersection(level, points[1], points[2]),
            edgeIntersection(level, points[2], points[3]),
            edgeIntersection(level, points[3], points[0]),
          ].filter(Boolean);
          for (let index = 0; index + 1 < crossings.length; index += 2) {
            segments.push({ level, start: crossings[index], end: crossings[index + 1] });
            if (segments.length === MAX_CONTOUR_SEGMENTS) {
              limited = true;
              break outer;
            }
          }
        }
      }
    }
    return { segments, limited };
  };

  const validatePaths = result => {
    if (result.paths === undefined) return [];
    if (!Array.isArray(result.paths)) throw new TypeError('result.paths must be an array.');
    if (result.paths.length > MAX_PATHS) {
      throw new RangeError(`result.paths cannot contain more than ${MAX_PATHS} paths.`);
    }
    return result.paths.map((path, pathIndex) => {
      requireObject(path, `result.paths[${pathIndex}]`);
      if (!Array.isArray(path.points) || path.points.length < 2 || path.points.length > MAX_PATH_POINTS) {
        throw new RangeError(
          `result.paths[${pathIndex}].points must contain between 2 and ${MAX_PATH_POINTS} points.`,
        );
      }
      const points = path.points.map((point, pointIndex) => {
        requirePoint(point, `result.paths[${pathIndex}].points[${pointIndex}]`);
        return { x: point.x, y: point.y };
      });
      const bounces = path.bounces ?? points.length - 2;
      if (!Number.isSafeInteger(bounces) || bounces < 0 || bounces > 5) {
        throw new RangeError(`result.paths[${pathIndex}].bounces must be between 0 and 5.`);
      }
      return { points, bounces, sourceId: path.sourceId ?? null };
    });
  };

  const prepareResult = result => {
    requireObject(result, 'result');
    if (metadataCache.has(result)) return metadataCache.get(result);
    requireView(result.view, 'result.view');
    const paths = validatePaths(result);
    if (typeof RoomWave.fieldMetadata !== 'function') {
      throw new Error('Field metadata validation is unavailable.');
    }
    const metadata = RoomWave.fieldMetadata(result);
    const scalarKey = result.view === 'coherent' ? 'levelDb' : 'energy';
    const values = result[scalarKey];
    if (values === undefined) {
      throw new TypeError(`A ${result.view} result must provide ${scalarKey}.`);
    }
    const normalized = new Float32Array(metadata.cellCount);
    if (result.view === 'coherent') {
      for (let index = 0; index < normalized.length; index += 1) {
        normalized[index] = clamp((values[index] - COHERENT_FLOOR_DB) / -COHERENT_FLOOR_DB);
      }
    } else {
      let maximum = 0;
      for (const value of values) maximum = Math.max(maximum, value);
      if (maximum > 0) {
        for (let index = 0; index < normalized.length; index += 1) {
          const relativeDb = values[index] > 0
            ? 10 * Math.log10(values[index] / maximum)
            : -Infinity;
          normalized[index] = Number.isFinite(relativeDb)
            ? clamp((relativeDb - COHERENT_FLOOR_DB) / -COHERENT_FLOOR_DB)
            : 0;
        }
      }
    }
    const contours = buildContours(result, metadata);
    const prepared = Object.freeze({
      metadata,
      normalized,
      scalarKey,
      paths,
      contourSegments: contours.segments,
      contoursLimited: contours.limited,
    });
    metadataCache.set(result, prepared);
    return prepared;
  };

  const screenPoint = (transform, point, name = 'point') => {
    const screen = {
      x: transform.offsetX + (point.x - transform.minX) * transform.scale,
      y: transform.offsetY + (point.y - transform.minY) * transform.scale,
    };
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) {
      throw new RangeError(`Derived ${name} screen coordinates must be finite.`);
    }
    return screen;
  };

  const wallOrder = (left, right) => (
    left.ay - right.ay
    || left.ax - right.ax
    || left.by - right.by
    || left.bx - right.bx
    || left.ny - right.ny
    || left.nx - right.nx
  );

  const emptyPlan = (state, viewport) => ({
    layers: [...LAYER_ORDER],
    emptyRoom: true,
    viewport,
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    transform: null,
    roomCells: [],
    roomCellKeys: new Set(),
    field: null,
    grid: { metersPerMajorLine: 1, scale: 0, lines: [] },
    walls: [],
    paths: [],
    sourceCones: [],
    sources: [],
    listeningPoint: null,
    legend: { view: state.analysis.view, title: 'Add room cells to begin' },
    result: null,
  });

  const buildRenderPlan = (state, result, rawViewport) => {
    const viewport = validateViewport(rawViewport);
    const validated = validateState(state);
    if (validated.cells.length === 0) return emptyPlan(state, viewport);

    const bounds = RoomWave.roomBounds(state.room.cells);
    const roomWidth = bounds.maxX - bounds.minX;
    const roomHeight = bounds.maxY - bounds.minY;
    if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, roomWidth, roomHeight].every(Number.isFinite)) {
      throw new RangeError('Derived room bounds must be finite.');
    }
    if (!(roomWidth > 0) || !(roomHeight > 0)) {
      throw new RangeError('Derived room spans must be greater than zero.');
    }
    const scale = Math.min(
      (viewport.width - PADDING * 2) / roomWidth,
      (viewport.height - PADDING * 2) / roomHeight,
    ) * state.ui.zoom;
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new RangeError('Derived room scale must be finite and greater than zero.');
    }
    const scaledWidth = roomWidth * scale;
    const scaledHeight = roomHeight * scale;
    const offsetX = (viewport.width - scaledWidth) / 2 + state.ui.pan.x;
    const offsetY = (viewport.height - scaledHeight) / 2 + state.ui.pan.y;
    if (![scaledWidth, scaledHeight, offsetX, offsetY].every(Number.isFinite)) {
      throw new RangeError('Derived room transform values must be finite.');
    }
    const transform = {
      minX: bounds.minX,
      minY: bounds.minY,
      scale,
      offsetX,
      offsetY,
    };

    let prepared = null;
    let screenPaths = [];
    if (result !== null && result !== undefined) {
      requireObject(result, 'result');
      requireView(result.view, 'result.view');
      if (result.view !== state.analysis.view) {
        throw new RangeError('Result view must match the current analysis view.');
      }
      if (result.coherent !== (result.view === 'coherent')) {
        throw new RangeError('Result coherent metadata must agree with its result view.');
      }
      prepared = prepareResult(result);
      const fieldStart = screenPoint(transform, {
        x: prepared.metadata.extentMinX,
        y: prepared.metadata.extentMinY,
      }, 'field');
      const fieldEnd = screenPoint(transform, {
        x: prepared.metadata.extentMaxX,
        y: prepared.metadata.extentMaxY,
      }, 'field');
      if (
        (prepared.metadata.width > 1 && !(fieldEnd.x > fieldStart.x))
        || (prepared.metadata.height > 1 && !(fieldEnd.y > fieldStart.y))
      ) throw new RangeError('Derived field screen spans must be greater than zero.');
      screenPaths = prepared.paths.map(path => ({
        ...path,
        screenPoints: path.points.map(point => screenPoint(transform, point, 'path')),
      }));
    }

    const roomCells = validated.cells.map(cell => {
      const screen = screenPoint(transform, cell, 'room cell');
      return { ...cell, screen: { ...screen, width: scale, height: scale } };
    });
    const gridLines = [];
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      gridLines.push({
        start: screenPoint(transform, { x, y: bounds.minY }, 'grid'),
        end: screenPoint(transform, { x, y: bounds.maxY }, 'grid'),
      });
    }
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      gridLines.push({
        start: screenPoint(transform, { x: bounds.minX, y }, 'grid'),
        end: screenPoint(transform, { x: bounds.maxX, y }, 'grid'),
      });
    }
    const walls = RoomWave.extractWallSegments(state.room.cells)
      .sort(wallOrder)
      .map(wall => ({
        ...wall,
        start: screenPoint(transform, { x: wall.ax, y: wall.ay }, 'wall'),
        end: screenPoint(transform, { x: wall.bx, y: wall.by }, 'wall'),
      }));
    const roomCellKeys = new Set(validated.cells.map(cell => cell.key));
    const sources = validated.sources.map(({ source, rotation }) => {
      const outside = !roomCellKeys.has(`${Math.floor(source.x)},${Math.floor(source.y)}`);
      return {
        ...source,
        screen: screenPoint(transform, source, 'source'),
        hitRadius: Math.max(12, Math.min(28, scale * 0.18)),
        selected: source.id === state.ui.selectedSourceId,
        directional: RoomWave.SOURCE_TYPES[source.type].directivity === 'directional',
        rotation,
        outside,
        warning: outside ? 'outside-room' : null,
      };
    });
    const sourceCones = sources
      .filter(source => source.selected && source.directional)
      .map(source => ({
        id: source.id,
        screen: source.screen,
        rotationRadians: source.rotation * Math.PI / 180,
        halfAngleRadians: Math.PI / 4,
        radius: Math.max(48, Math.min(180, scale * 1.5)),
      }));
    const listeningPoint = {
      ...state.listeningPoint,
      screen: screenPoint(transform, state.listeningPoint, 'listening point'),
      hitRadius: 12,
    };
    const legend = state.analysis.view === 'coherent'
      ? {
        view: 'coherent',
        title: 'Relative pressure level',
        lowLabel: `${COHERENT_FLOOR_DB} dB`,
        highLabel: '0 dB',
        contours: '3 dB contours',
        contoursLimited: prepared?.contoursLimited ?? false,
      }
      : {
        view: state.analysis.view,
        title: state.analysis.view === 'paths'
          ? 'Relative ray energy'
          : 'Relative broadband energy',
        lowLabel: 'Low',
        highLabel: 'High',
      };

    return {
      layers: [...LAYER_ORDER],
      emptyRoom: false,
      viewport,
      bounds,
      transform,
      roomCells,
      roomCellKeys,
      field: prepared ? { metadata: prepared.metadata, prepared, transform } : null,
      grid: { metersPerMajorLine: 1, scale, lines: gridLines },
      walls,
      paths: screenPaths,
      sourceCones,
      sources,
      listeningPoint,
      legend,
      result: result ?? null,
    };
  };

  const validatePlan = plan => {
    requireObject(plan, 'plan');
    if (!Array.isArray(plan.layers) || plan.layers.length !== LAYER_ORDER.length) {
      throw new TypeError('plan.layers must contain the renderer layer order.');
    }
    if (!plan.layers.every((layer, index) => layer === LAYER_ORDER[index])) {
      throw new RangeError('plan.layers must use the renderer layer order.');
    }
    const viewport = validateViewport(plan.viewport);
    if (
      plan.viewport.backingWidth !== viewport.backingWidth
      || plan.viewport.backingHeight !== viewport.backingHeight
    ) throw new RangeError('Plan backing dimensions must match its validated viewport.');
  };

  const hitTest = (plan, point) => {
    validatePlan(plan);
    requirePoint(point, 'point');
    for (let index = plan.sources.length - 1; index >= 0; index -= 1) {
      const source = plan.sources[index];
      if (Math.hypot(point.x - source.screen.x, point.y - source.screen.y) <= source.hitRadius) {
        return { kind: 'source', id: source.id };
      }
    }
    if (
      plan.listeningPoint
      && Math.hypot(
        point.x - plan.listeningPoint.screen.x,
        point.y - plan.listeningPoint.screen.y,
      ) <= plan.listeningPoint.hitRadius
    ) return { kind: 'listening-point' };
    if (!plan.transform) return null;
    const worldX = plan.transform.minX + (point.x - plan.transform.offsetX) / plan.transform.scale;
    const worldY = plan.transform.minY + (point.y - plan.transform.offsetY) / plan.transform.scale;
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return null;
    const x = Math.floor(worldX);
    const y = Math.floor(worldY);
    return {
      kind: 'cell',
      x,
      y,
      filled: plan.roomCellKeys.has(`${x},${y}`),
    };
  };

  const requireContext = context => {
    requireObject(context, 'context');
    requireObject(context.canvas, 'context.canvas');
    for (const method of [
      'setTransform', 'save', 'restore', 'fillRect', 'beginPath', 'rect', 'clip',
      'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'closePath', 'setLineDash',
      'translate', 'rotate', 'fillText',
    ]) {
      if (typeof context[method] !== 'function') {
        throw new TypeError(`context.${method} must be a function.`);
      }
    }
  };
  const strokeSegments = (context, segments) => {
    context.beginPath();
    for (const segment of segments) {
      context.moveTo(segment.start.x, segment.start.y);
      context.lineTo(segment.end.x, segment.end.y);
    }
    context.stroke();
  };
  const clipRoom = (context, plan) => {
    context.beginPath();
    for (const cell of plan.roomCells) {
      context.rect(cell.screen.x, cell.screen.y, cell.screen.width, cell.screen.height);
    }
    context.clip();
  };
  const fieldInterval = (metadata, index, count) => {
    if (metadata.layout === 'cell-binned') {
      return [
        metadata.originX + index * metadata.spacing,
        metadata.originX + (index + 1) * metadata.spacing,
      ];
    }
    const sample = metadata.sampleMinX + index * metadata.spacing;
    return [
      index === 0 ? metadata.extentMinX : sample - metadata.spacing / 2,
      index === count - 1 ? metadata.extentMaxX : sample + metadata.spacing / 2,
    ];
  };
  const fieldYInterval = (metadata, index, count) => {
    if (metadata.layout === 'cell-binned') {
      return [
        metadata.originY + index * metadata.spacing,
        metadata.originY + (index + 1) * metadata.spacing,
      ];
    }
    const sample = metadata.sampleMinY + index * metadata.spacing;
    return [
      index === 0 ? metadata.extentMinY : sample - metadata.spacing / 2,
      index === count - 1 ? metadata.extentMaxY : sample + metadata.spacing / 2,
    ];
  };
  const drawField = (context, plan) => {
    if (!plan.field) return;
    const { metadata, prepared, transform } = plan.field;
    const inside = plan.result.inside;
    const palette = paletteTables[plan.result.view];
    context.save();
    clipRoom(context, plan);
    context.globalAlpha = 0.78;
    for (let y = 0; y < metadata.height; y += 1) {
      const [worldTop, worldBottom] = fieldYInterval(metadata, y, metadata.height);
      const top = screenPoint(transform, { x: metadata.originX, y: worldTop }, 'field').y;
      const bottom = screenPoint(transform, { x: metadata.originX, y: worldBottom }, 'field').y;
      for (let x = 0; x < metadata.width; x += 1) {
        const index = y * metadata.width + x;
        if (inside && !inside[index]) continue;
        const [worldLeft, worldRight] = fieldInterval(metadata, x, metadata.width);
        const left = screenPoint(transform, { x: worldLeft, y: metadata.originY }, 'field').x;
        const right = screenPoint(transform, { x: worldRight, y: metadata.originY }, 'field').x;
        context.fillStyle = palette[Math.round(prepared.normalized[index] * 255)];
        context.fillRect(left, top, right - left, bottom - top);
      }
    }
    context.restore();
  };
  const drawContours = (context, plan) => {
    if (!plan.field || plan.result.view !== 'coherent') return;
    context.save();
    clipRoom(context, plan);
    context.strokeStyle = 'rgba(226, 232, 240, 0.58)';
    context.lineWidth = 0.8;
    context.beginPath();
    for (const segment of plan.field.prepared.contourSegments) {
      const start = screenPoint(plan.transform, segment.start, 'contour');
      const end = screenPoint(plan.transform, segment.end, 'contour');
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
    }
    context.stroke();
    context.restore();
  };
  const drawPaths = (context, plan) => {
    if (!plan.paths.length) return;
    context.save();
    clipRoom(context, plan);
    for (const path of plan.paths) {
      context.strokeStyle = `rgba(251, 146, 60, ${Math.max(0.18, 0.72 - path.bounces * 0.1)})`;
      context.lineWidth = path.bounces === 0 ? 1.8 : 1;
      context.beginPath();
      path.screenPoints.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.stroke();
    }
    context.restore();
  };
  const drawSourceCones = (context, plan) => {
    context.save();
    context.fillStyle = 'rgba(251, 146, 60, 0.12)';
    context.strokeStyle = 'rgba(251, 146, 60, 0.55)';
    context.lineWidth = 1;
    for (const cone of plan.sourceCones) {
      context.beginPath();
      context.moveTo(cone.screen.x, cone.screen.y);
      context.arc(
        cone.screen.x,
        cone.screen.y,
        cone.radius,
        cone.rotationRadians - cone.halfAngleRadians,
        cone.rotationRadians + cone.halfAngleRadians,
      );
      context.closePath();
      context.fill();
      context.stroke();
    }
    context.restore();
  };
  const drawSources = (context, plan) => {
    for (const source of plan.sources) {
      context.save();
      context.translate(source.screen.x, source.screen.y);
      context.rotate(source.rotation * Math.PI / 180);
      context.fillStyle = source.directional ? '#fb923c' : '#38bdf8';
      context.strokeStyle = source.selected ? '#e2e8f0' : '#07111f';
      context.lineWidth = source.selected ? 3 : 1.5;
      context.beginPath();
      context.arc(0, 0, 8, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      if (source.directional) {
        context.beginPath();
        context.moveTo(5, 0);
        context.lineTo(15, 0);
        context.stroke();
      }
      if (source.outside) {
        context.strokeStyle = '#e2e8f0';
        context.lineWidth = 2;
        context.setLineDash([3, 3]);
        context.beginPath();
        context.arc(0, 0, 13, 0, Math.PI * 2);
        context.stroke();
        context.setLineDash([]);
        context.beginPath();
        context.moveTo(-6, -6);
        context.lineTo(6, 6);
        context.moveTo(6, -6);
        context.lineTo(-6, 6);
        context.stroke();
      }
      context.restore();
    }
  };
  const drawListeningPoint = (context, plan) => {
    if (!plan.listeningPoint) return;
    const { x, y } = plan.listeningPoint.screen;
    context.save();
    context.strokeStyle = '#e2e8f0';
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(x, y, 8, 0, Math.PI * 2);
    context.moveTo(x - 13, y);
    context.lineTo(x + 13, y);
    context.moveTo(x, y - 13);
    context.lineTo(x, y + 13);
    context.stroke();
    context.restore();
  };
  const drawLegend = (context, plan) => {
    const x = 16;
    const y = plan.viewport.height - 32;
    context.save();
    context.font = '12px ui-monospace, monospace';
    context.fillStyle = '#e2e8f0';
    if (plan.emptyRoom) {
      context.fillText(plan.legend.title, x, y);
      context.restore();
      return;
    }
    const table = paletteTables[plan.legend.view];
    for (let index = 0; index < 64; index += 1) {
      context.fillStyle = table[Math.round(index / 63 * 255)];
      context.fillRect(x + index * 2, y - 10, 2, 8);
    }
    context.fillStyle = '#e2e8f0';
    context.fillText(plan.legend.title, x, y - 15);
    context.fillText(plan.legend.lowLabel, x, y + 12);
    context.fillText(plan.legend.highLabel, x + 128, y + 12);
    if (plan.legend.contoursLimited) {
      context.fillText('Contour detail limited by render budget', x, y + 27);
    }
    context.restore();
  };

  const DRAW_LAYER = {
    blueprint(context, plan) {
      context.fillStyle = '#07111f';
      context.fillRect(0, 0, plan.viewport.width, plan.viewport.height);
    },
    room(context, plan) {
      context.fillStyle = '#10243b';
      for (const cell of plan.roomCells) {
        context.fillRect(cell.screen.x, cell.screen.y, cell.screen.width, cell.screen.height);
      }
    },
    field: drawField,
    grid(context, plan) {
      context.save();
      context.strokeStyle = '#1b3652';
      context.lineWidth = 1;
      strokeSegments(context, plan.grid.lines);
      context.restore();
    },
    walls(context, plan) {
      context.save();
      context.strokeStyle = '#e2e8f0';
      context.lineWidth = 2;
      strokeSegments(context, plan.walls);
      context.restore();
    },
    contours: drawContours,
    paths: drawPaths,
    sourceCones: drawSourceCones,
    sources: drawSources,
    listeningPoint: drawListeningPoint,
    legend: drawLegend,
  };

  const renderRoom = (context, plan) => {
    requireContext(context);
    validatePlan(plan);
    context.canvas.width = plan.viewport.backingWidth;
    context.canvas.height = plan.viewport.backingHeight;
    context.setTransform(plan.viewport.dpr, 0, 0, plan.viewport.dpr, 0, 0);
    for (const layer of plan.layers) DRAW_LAYER[layer](context, plan);
    return [...plan.layers];
  };

  return { buildRenderPlan, renderRoom, hitTest, fieldColor };
});
