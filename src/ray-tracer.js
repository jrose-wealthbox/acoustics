(function (root, factory) {
  const dependencies = (
    typeof module !== 'undefined' && module.exports
      ? { ...require('./sources.js'), ...require('./acoustics.js') }
      : (root.RoomWave || {})
  );
  const api = factory(dependencies);
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function (RoomWave) {
  const RAY_EPSILON = 1e-6;
  const INTERSECTION_EPSILON = 1e-9;
  const PARALLEL_EPSILON = 1e-12;
  const MAX_RAYS = 1440;
  const MAX_BOUNCES = 5;
  const MAX_WALLS = 3600;
  const MAX_SOURCES = 14;
  const MAX_FREQUENCIES = 128;
  const MAX_COVERAGE_DEPOSITS = 50000000;
  const MAX_RAY_INTERSECTIONS = 20000000;
  const MAX_ROOM_SPAN = 30;
  const MAP_RESOLUTIONS = new Set([0.1, 0.25, 0.5, 1]);

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
  const requireFiniteVectorLength = (value, name) => {
    const length = Math.hypot(value.x, value.y);
    if (!Number.isFinite(length)) {
      throw new RangeError(`${name} must have a finite derived length.`);
    }
    if (length === 0) throw new RangeError(`${name} must be non-zero.`);
    return length;
  };

  const reflectUnchecked = (direction, normal) => {
    const dot = direction.x * normal.x + direction.y * normal.y;
    return {
      x: direction.x - 2 * dot * normal.x,
      y: direction.y - 2 * dot * normal.y,
    };
  };

  const reflect = (direction, normal) => {
    requirePoint(direction, 'direction');
    requirePoint(normal, 'normal');
    requireFiniteVectorLength(direction, 'direction');
    const normalLength = requireFiniteVectorLength(normal, 'normal');
    if (Math.abs(normalLength - 1) > 1e-12) {
      throw new RangeError('normal must be a unit vector.');
    }
    const result = reflectUnchecked(direction, normal);
    if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) {
      throw new RangeError('reflection must have finite derived components.');
    }
    return result;
  };

  const intersectUnchecked = (origin, direction, segment) => {
    const sx = segment.bx - segment.ax;
    const sy = segment.by - segment.ay;
    const denominator = direction.x * sy - direction.y * sx;
    if (Math.abs(denominator) < PARALLEL_EPSILON) return null;
    const qx = segment.ax - origin.x;
    const qy = segment.ay - origin.y;
    const distance = (qx * sy - qy * sx) / denominator;
    const unit = (qx * direction.y - qy * direction.x) / denominator;
    // Endpoint tolerance lets mathematically coincident corner walls participate in the same
    // hit even when one cross-product rounds a few ULPs beyond its nominal [0, 1] segment range.
    return distance > INTERSECTION_EPSILON
      && unit >= -INTERSECTION_EPSILON
      && unit <= 1 + INTERSECTION_EPSILON ? {
      x: origin.x + distance * direction.x,
      y: origin.y + distance * direction.y,
      distance,
      segment,
    } : null;
  };

  const requireWall = (wall, name) => {
    requireObject(wall, name);
    for (const key of ['ax', 'ay', 'bx', 'by', 'nx', 'ny']) {
      requireFiniteNumber(wall[key], `${name}.${key}`);
    }
    const horizontal = wall.ay === wall.by && wall.ax !== wall.bx;
    const vertical = wall.ax === wall.bx && wall.ay !== wall.by;
    if (!horizontal && !vertical) throw new RangeError(`${name} must be a non-zero axis-aligned segment.`);
    if (
      (horizontal && (wall.nx !== 0 || Math.abs(wall.ny) !== 1))
      || (vertical && (wall.ny !== 0 || Math.abs(wall.nx) !== 1))
    ) throw new RangeError(`${name} must have a perpendicular cardinal unit normal.`);
  };

  const intersectRaySegment = (origin, direction, segment) => {
    requirePoint(origin, 'origin');
    requirePoint(direction, 'direction');
    requireFiniteVectorLength(direction, 'direction');
    requireWall(segment, 'segment');
    const sx = segment.bx - segment.ax;
    const sy = segment.by - segment.ay;
    const qx = segment.ax - origin.x;
    const qy = segment.ay - origin.y;
    const denominator = direction.x * sy - direction.y * sx;
    const distanceNumerator = qx * sy - qy * sx;
    const unitNumerator = qx * direction.y - qy * direction.x;
    if (![sx, sy, qx, qy, denominator, distanceNumerator, unitNumerator].every(Number.isFinite)) {
      throw new RangeError('ray intersection must have finite derived values.');
    }
    return intersectUnchecked(origin, direction, segment);
  };

  const nearestIntersection = (origin, direction, walls) => {
    let nearest = null;
    // This wall scan sits inside every angle/bounce iteration. It skips public validation and
    // retains one best hit in-place so the standard 2° loop creates no sortable hit arrays.
    for (const wall of walls) {
      const hit = intersectUnchecked(origin, direction, wall);
      if (!hit) continue;
      const tolerance = INTERSECTION_EPSILON * Math.max(1, hit.distance, nearest?.distance || 0);
      if (!nearest || hit.distance < nearest.distance - tolerance) {
        nearest = { ...hit, segments: [wall] };
      } else if (
        Math.abs(hit.distance - nearest.distance) <= tolerance
        && Math.hypot(hit.x - nearest.x, hit.y - nearest.y) <= tolerance
      ) {
        nearest.segments.push(wall);
      }
    }
    return nearest;
  };

  const pointOnWall = (point, wall) => {
    if (wall.ax === wall.bx) {
      return point.x === wall.ax
        && point.y >= Math.min(wall.ay, wall.by)
        && point.y <= Math.max(wall.ay, wall.by);
    }
    return point.y === wall.ay
      && point.x >= Math.min(wall.ax, wall.bx)
      && point.x <= Math.max(wall.ax, wall.bx);
  };

  const pointInsideWalls = (point, walls) => {
    if (walls.some(wall => pointOnWall(point, wall))) return false;
    let crossings = 0;
    for (const wall of walls) {
      if (wall.ax !== wall.bx) continue;
      const minY = Math.min(wall.ay, wall.by);
      const maxY = Math.max(wall.ay, wall.by);
      // The half-open vertical interval counts shared vertices once; changing this convention
      // breaks concave-corner parity even though every segment remains individually valid.
      if (point.y >= minY && point.y < maxY && wall.ax > point.x) crossings += 1;
    }
    return crossings % 2 === 1;
  };

  const validateWalls = snapshot => {
    requireObject(snapshot, 'snapshot');
    requireObject(snapshot.room, 'snapshot.room');
    const { walls } = snapshot.room;
    if (!Array.isArray(walls) || walls.length === 0) {
      throw new TypeError('snapshot.room.walls must be a nonempty array.');
    }
    if (walls.length > MAX_WALLS) {
      throw new RangeError(`snapshot.room.walls cannot contain more than ${MAX_WALLS} segments.`);
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    walls.forEach((wall, index) => {
      requireWall(wall, `snapshot.room.walls[${index}]`);
      minX = Math.min(minX, wall.ax, wall.bx);
      minY = Math.min(minY, wall.ay, wall.by);
      maxX = Math.max(maxX, wall.ax, wall.bx);
      maxY = Math.max(maxY, wall.ay, wall.by);
    });

    const canonicalSegments = new Set();
    const collinearGroups = new Map();
    const endpointGraph = new Map();
    const endpointKey = (x, y) => `${x},${y}`;
    const addEndpoint = (x, y, otherX, otherY) => {
      const key = endpointKey(x, y);
      if (!endpointGraph.has(key)) endpointGraph.set(key, new Set());
      endpointGraph.get(key).add(endpointKey(otherX, otherY));
    };
    walls.forEach((wall, index) => {
      const forward = wall.ax < wall.bx || (wall.ax === wall.bx && wall.ay < wall.by);
      const startKey = endpointKey(forward ? wall.ax : wall.bx, forward ? wall.ay : wall.by);
      const endKey = endpointKey(forward ? wall.bx : wall.ax, forward ? wall.by : wall.ay);
      const canonicalKey = `${startKey}|${endKey}`;
      if (canonicalSegments.has(canonicalKey)) {
        throw new RangeError(`snapshot.room.walls[${index}] duplicates an existing wall, including reversed duplicates.`);
      }
      canonicalSegments.add(canonicalKey);

      const horizontal = wall.ay === wall.by;
      const groupKey = horizontal ? `h:${wall.ay}` : `v:${wall.ax}`;
      if (!collinearGroups.has(groupKey)) collinearGroups.set(groupKey, []);
      collinearGroups.get(groupKey).push({
        start: horizontal ? Math.min(wall.ax, wall.bx) : Math.min(wall.ay, wall.by),
        end: horizontal ? Math.max(wall.ax, wall.bx) : Math.max(wall.ay, wall.by),
        normal: `${wall.nx},${wall.ny}`,
        index,
      });
      addEndpoint(wall.ax, wall.ay, wall.bx, wall.by);
      addEndpoint(wall.bx, wall.by, wall.ax, wall.ay);
    });

    for (const group of collinearGroups.values()) {
      group.sort((left, right) => left.start - right.start || left.end - right.end);
      let previous = group[0];
      for (const current of group.slice(1)) {
        if (current.start < previous.end) {
          throw new RangeError(
            `snapshot.room.walls[${current.index}] overlaps another collinear wall.`,
          );
        }
        if (current.start === previous.end && current.normal === previous.normal) {
          throw new RangeError(
            `snapshot.room.walls contains adjacent same-normal segments that must be merged.`,
          );
        }
        previous = current;
      }
    }

    const horizontalWalls = walls.filter(wall => wall.ay === wall.by);
    const verticalWalls = walls.filter(wall => wall.ax === wall.bx);
    for (const horizontal of horizontalWalls) {
      const minX = Math.min(horizontal.ax, horizontal.bx);
      const maxX = Math.max(horizontal.ax, horizontal.bx);
      for (const vertical of verticalWalls) {
        const minY = Math.min(vertical.ay, vertical.by);
        const maxY = Math.max(vertical.ay, vertical.by);
        if (
          vertical.ax < minX || vertical.ax > maxX
          || horizontal.ay < minY || horizontal.ay > maxY
        ) continue;
        const horizontalEndpoint = vertical.ax === horizontal.ax || vertical.ax === horizontal.bx;
        const verticalEndpoint = horizontal.ay === vertical.ay || horizontal.ay === vertical.by;
        if (!horizontalEndpoint || !verticalEndpoint) {
          throw new RangeError(
            'snapshot.room.walls contains perpendicular segments that intersect away from shared endpoints.',
          );
        }
      }
    }

    for (const [key, neighbors] of endpointGraph) {
      // Connected, hole-free polyominoes extracted by geometry have one simple boundary and
      // degree-two corners. A degree-four touch requires diagonal-only contact or a pinched hole,
      // both rejected by the room topology contract before wall extraction.
      if (neighbors.size !== 2) {
        throw new RangeError(
          `snapshot.room.walls must form a closed boundary; endpoint ${key} has degree ${neighbors.size}, not 2.`,
        );
      }
    }
    const firstEndpoint = endpointGraph.keys().next().value;
    const visited = new Set(firstEndpoint === undefined ? [] : [firstEndpoint]);
    const queue = firstEndpoint === undefined ? [] : [firstEndpoint];
    for (let index = 0; index < queue.length; index += 1) {
      for (const neighbor of endpointGraph.get(queue[index])) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    if (visited.size !== endpointGraph.size) {
      throw new RangeError(
        'snapshot.room.walls must form one connected boundary; disconnected loops and hole boundaries are not supported.',
      );
    }

    const width = maxX - minX;
    const height = maxY - minY;
    if (!(width > 0 && height > 0 && width <= MAX_ROOM_SPAN && height <= MAX_ROOM_SPAN)) {
      throw new RangeError(`snapshot.room.walls must bound a room no larger than ${MAX_ROOM_SPAN} × ${MAX_ROOM_SPAN} m.`);
    }
    return { walls, minX, minY, maxX, maxY, width, height };
  };

  const validateSource = (source, bounds, name = 'source') => {
    requireObject(source, name);
    if (typeof source.id !== 'string' || source.id.length === 0) {
      throw new TypeError(`${name}.id must be a nonempty string.`);
    }
    if (typeof source.type !== 'string' || !Object.hasOwn(RoomWave.SOURCE_TYPES, source.type)) {
      throw new RangeError(`${name}.type must match the source catalog.`);
    }
    for (const key of ['x', 'y', 'z', 'gainDb', 'delayMs', 'rotation']) {
      requireFiniteNumber(source[key], `${name}.${key}`);
    }
    if (source.gainDb < -12 || source.gainDb > 6) {
      throw new RangeError(`${name}.gainDb must be between -12 and 6.`);
    }
    if (source.delayMs < 0 || source.delayMs > 20) {
      throw new RangeError(`${name}.delayMs must be between 0 and 20.`);
    }
    if (source.polarity !== 'normal' && source.polarity !== 'inverted') {
      throw new RangeError(`${name}.polarity must be normal or inverted.`);
    }
    if (!pointInsideWalls(source, bounds.walls)) {
      throw new RangeError(`${name} must be strictly inside the room walls.`);
    }
    return {
      ...source,
      rotation: ((source.rotation % 360) + 360) % 360,
    };
  };

  const validateTraceOptions = options => {
    requireObject(options, 'options');
    const angularStepDegrees = options.angularStepDegrees ?? 2;
    const maxBounces = options.maxBounces ?? MAX_BOUNCES;
    requireFiniteNumber(angularStepDegrees, 'angularStepDegrees');
    if (angularStepDegrees <= 0 || angularStepDegrees > 360) {
      throw new RangeError('angularStepDegrees must be greater than zero and no greater than 360.');
    }
    const rayCount = Math.ceil(360 / angularStepDegrees);
    if (rayCount > MAX_RAYS) throw new RangeError(`ray count cannot exceed ${MAX_RAYS}.`);
    if (!Number.isSafeInteger(maxBounces) || maxBounces < 0 || maxBounces > MAX_BOUNCES) {
      throw new RangeError(`maxBounces must be an integer between 0 and ${MAX_BOUNCES}.`);
    }
    return { angularStepDegrees, maxBounces, rayCount };
  };

  const tracePrepared = (bounds, source, traceOptions) => {
    const { angularStepDegrees, maxBounces, rayCount } = traceOptions;
    const paths = [];
    for (let rayIndex = 0; rayIndex < rayCount; rayIndex += 1) {
      const angle = rayIndex * angularStepDegrees * Math.PI / 180;
      let direction = { x: Math.cos(angle), y: Math.sin(angle) };
      let queryOrigin = { x: source.x, y: source.y };
      let visibleStart = queryOrigin;
      let totalLength = 0;
      const points = [{ ...queryOrigin }];

      for (let bounces = 0; bounces <= maxBounces; bounces += 1) {
        const hit = nearestIntersection(queryOrigin, direction, bounds.walls);
        if (!hit) break;
        const segmentLength = Math.hypot(hit.x - visibleStart.x, hit.y - visibleStart.y);
        if (!(segmentLength > INTERSECTION_EPSILON) || !Number.isFinite(segmentLength)) break;
        const startLength = totalLength;
        totalLength += segmentLength;
        points.push({ x: hit.x, y: hit.y });
        paths.push({
          sourceId: source.id,
          rayIndex,
          bounces,
          length: totalLength,
          startLength,
          angle,
          start: { ...visibleStart },
          end: { x: hit.x, y: hit.y },
          points: points.map(point => ({ ...point })),
        });
        if (bounces === maxBounces) break;

        // A corner is two simultaneous wall hits. Reflecting across each distinct cardinal
        // normal reverses both components and keeps that measure-zero ray inside the polygon.
        const reflectedNormals = new Set();
        for (const wall of hit.segments) {
          const key = `${wall.nx},${wall.ny}`;
          if (reflectedNormals.has(key)) continue;
          reflectedNormals.add(key);
          direction = reflectUnchecked(direction, { x: wall.nx, y: wall.ny });
        }
        if (!Number.isFinite(direction.x) || !Number.isFinite(direction.y)) break;
        visibleStart = { x: hit.x, y: hit.y };
        // Starting just inside the reflected direction prevents the wall we just hit from
        // winning again at floating-point distance zero, which otherwise creates self-hit loops.
        queryOrigin = {
          x: hit.x + direction.x * RAY_EPSILON,
          y: hit.y + direction.y * RAY_EPSILON,
        };
      }
    }
    return paths;
  };

  const requireIntersectionBudget = (sourceCount, wallCount, traceOptions) => {
    const intersections = sourceCount
      * wallCount
      * traceOptions.rayCount
      * (traceOptions.maxBounces + 1);
    // Every ray/bounce scans every wall for its nearest hit, so bound that product separately
    // from heatmap deposits before entering the performance-critical intersection loop.
    if (!Number.isSafeInteger(intersections) || intersections > MAX_RAY_INTERSECTIONS) {
      throw new RangeError(
        `Ray tracing exceeds the ${MAX_RAY_INTERSECTIONS.toLocaleString('en-US')} intersection work budget.`,
      );
    }
    return intersections;
  };

  const traceSourcePaths = (snapshot, source, options = {}) => {
    const bounds = validateWalls(snapshot);
    const validatedSource = validateSource(source, bounds);
    const traceOptions = validateTraceOptions(options);
    requireIntersectionBudget(1, bounds.walls.length, traceOptions);
    return tracePrepared(bounds, validatedSource, traceOptions);
  };

  const mapDimension = (span, resolution, name) => {
    const ratio = span / resolution;
    const nearest = Math.round(ratio);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8;
    const count = Math.abs(ratio - nearest) <= tolerance ? nearest : Math.ceil(ratio);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
    return count;
  };

  const airLossDbPerMeter = frequency => 0.0002 * ((frequency / 1000) ** 1.7);

  const depositPathEnergy = (target, inside, map, path, baseAmplitude, frequency, reflection) => {
    const segmentLength = path.length - path.startLength;
    const sampleCount = Math.max(1, Math.ceil(segmentLength / (map.resolution / 2)));
    const cells = new Map();
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const ratio = (sample + 0.5) / sampleCount;
      const x = path.start.x + (path.end.x - path.start.x) * ratio;
      const y = path.start.y + (path.end.y - path.start.y) * ratio;
      const cellX = Math.floor((x - map.originX) / map.resolution);
      const cellY = Math.floor((y - map.originY) / map.resolution);
      if (cellX < 0 || cellX >= map.width || cellY < 0 || cellY >= map.height) continue;
      const index = cellY * map.width + cellX;
      if (!inside[index] || cells.has(index)) continue;
      cells.set(index, path.startLength + segmentLength * ratio);
    }

    const reflectedAmplitude = reflection ** path.bounces;
    if (reflectedAmplitude === 0) return 0;
    let depositedEnergy = 0;
    for (const [index, distance] of cells) {
      const spreadingDistance = Math.max(distance, map.resolution / 2);
      const airAmplitude = 10 ** (-(airLossDbPerMeter(frequency) * distance) / 20);
      const amplitude = baseAmplitude * reflectedAmplitude * airAmplitude / spreadingDistance;
      const energy = amplitude * amplitude;
      target[index] += energy;
      depositedEnergy += energy;
    }
    return depositedEnergy;
  };

  const representativePaths = (paths, rayCount) => {
    const stride = Math.max(1, Math.round(rayCount / 36));
    const lastByRay = new Map();
    for (const path of paths) {
      if (path.rayIndex % stride === 0) lastByRay.set(path.rayIndex, path);
    }
    return [...lastByRay.values()];
  };

  const accumulateRayCoverage = (snapshot, frequencies) => {
    const bounds = validateWalls(snapshot);
    requireFiniteNumber(snapshot.room.absorption, 'snapshot.room.absorption');
    if (snapshot.room.absorption < 0 || snapshot.room.absorption > 1) {
      throw new RangeError('snapshot.room.absorption must be between 0 and 1.');
    }
    requireObject(snapshot.acoustics, 'snapshot.acoustics');
    requireFiniteNumber(snapshot.acoustics.speedOfSound, 'snapshot.acoustics.speedOfSound');
    if (snapshot.acoustics.speedOfSound <= 0) {
      throw new RangeError('snapshot.acoustics.speedOfSound must be greater than zero.');
    }
    requireObject(snapshot.analysis, 'snapshot.analysis');
    const resolution = snapshot.analysis.mapResolution;
    if (!MAP_RESOLUTIONS.has(resolution)) {
      throw new RangeError('snapshot.analysis.mapResolution must be 0.1, 0.25, 0.5, or 1.');
    }
    if (!Array.isArray(snapshot.sources)) throw new TypeError('snapshot.sources must be an array.');
    if (snapshot.sources.length > MAX_SOURCES) {
      throw new RangeError(`snapshot.sources cannot contain more than ${MAX_SOURCES} sources.`);
    }
    const sources = snapshot.sources.map((source, index) => (
      validateSource(source, bounds, `snapshot.sources[${index}]`)
    ));
    if (!Array.isArray(frequencies) || frequencies.length === 0) {
      throw new TypeError('frequencies must be a nonempty array.');
    }
    if (frequencies.length > MAX_FREQUENCIES) {
      throw new RangeError(`frequencies cannot contain more than ${MAX_FREQUENCIES} values.`);
    }
    frequencies.forEach((frequency, index) => {
      requireFiniteNumber(frequency, `frequencies[${index}]`);
      if (frequency <= 0) throw new RangeError(`frequencies[${index}] must be greater than zero.`);
    });

    const traceOptions = validateTraceOptions({});
    requireIntersectionBudget(sources.length, bounds.walls.length, traceOptions);
    const longestSegmentSamples = Math.ceil(
      Math.hypot(bounds.width, bounds.height) / (resolution / 2),
    );
    const estimatedDeposits = sources.length
      * frequencies.length
      * traceOptions.rayCount
      * (traceOptions.maxBounces + 1)
      * longestSegmentSamples;
    // This conservative bound is checked before tracing or allocating band maps. It preserves
    // normal 2°/five-bounce workloads while rejecting direct calls that could require billions
    // of per-frequency cell deposits on the main thread or worker.
    if (!Number.isSafeInteger(estimatedDeposits) || estimatedDeposits > MAX_COVERAGE_DEPOSITS) {
      throw new RangeError(
        `Ray coverage exceeds the ${MAX_COVERAGE_DEPOSITS.toLocaleString('en-US')} deposit work budget.`,
      );
    }

    const width = mapDimension(bounds.width, resolution, 'coverage width');
    const height = mapDimension(bounds.height, resolution, 'coverage height');
    const map = { width, height, resolution, originX: bounds.minX, originY: bounds.minY };
    const inside = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        inside[y * width + x] = Number(pointInsideWalls({
          x: bounds.minX + (x + 0.5) * resolution,
          y: bounds.minY + (y + 0.5) * resolution,
        }, bounds.walls));
      }
    }

    const tracedSources = sources.map(source => ({
      source,
      paths: tracePrepared(bounds, source, traceOptions),
    }));
    const reflection = RoomWave.reflectionAmplitude(snapshot.room.absorption);
    const rayWeight = 1 / traceOptions.rayCount;
    const bands = frequencies.map(frequency => {
      const energy = new Float64Array(width * height);
      const bounceEnergy = new Float64Array(MAX_BOUNCES + 1);
      for (const traced of tracedSources) {
        const responseDb = RoomWave.sourceResponseDb(traced.source.type, frequency);
        if (responseDb === -Infinity) continue;
        // Coverage sums energy, not coherent pressure, so source delay and polarity intentionally
        // do not create interference terms in this high-frequency geometric approximation.
        const sourceAmplitude = 10 ** ((responseDb + traced.source.gainDb) / 20);
        const rotation = traced.source.rotation * Math.PI / 180;
        for (const path of traced.paths) {
          const directivity = RoomWave.directionalGain(traced.source.type, path.angle - rotation);
          bounceEnergy[path.bounces] += depositPathEnergy(
            energy,
            inside,
            map,
            path,
            sourceAmplitude * directivity * Math.sqrt(rayWeight),
            frequency,
            reflection,
          );
        }
      }
      return { frequency, energy, bounceEnergy };
    });

    const energy = new Float64Array(width * height);
    for (const band of bands) {
      for (let index = 0; index < energy.length; index += 1) {
        energy[index] += band.energy[index] / bands.length;
      }
    }
    const selectedSourceId = snapshot.ui?.selectedSourceId || sources[0]?.id || null;
    const selectedTrace = tracedSources.find(({ source }) => source.id === selectedSourceId);
    const paths = selectedTrace
      ? representativePaths(selectedTrace.paths, traceOptions.rayCount)
      : [];

    return {
      ...map,
      coherent: false,
      model: 'incoherent-ray-energy',
      inside,
      energy,
      bands,
      paths,
      reflectionBounces: MAX_BOUNCES,
    };
  };

  return {
    intersectRaySegment,
    reflect,
    traceSourcePaths,
    accumulateRayCoverage,
  };
});
