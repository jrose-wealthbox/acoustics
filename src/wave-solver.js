(function (root, factory) {
  const api = factory(root.RoomWave || {});
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function (RoomWave) {
  const MAX_WAVE_CELLS = 160000;
  const MAX_ROOM_CELLS = 900;
  const MAX_ROOM_SPAN = 30;
  const MAX_SOURCES = 14;
  const MAX_TIME_STEPS = 200000;
  const PROGRESS_STEPS = 64;
  const YIELD_STEPS = 32;
  const AIR_DAMPING = 0.0001;
  const DRIVE_SCALE = 0.001;
  const DISPLAY_FLOOR_DB = -60;
  const CELL_KEY = /^-?(?:0|[1-9]\d*),-?(?:0|[1-9]\d*)$/;

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
  const requirePositiveNumber = (value, name) => {
    requireFiniteNumber(value, name);
    if (value <= 0) throw new RangeError(`${name} must be greater than zero.`);
  };
  const requireSafeCount = (value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  };
  const checkedProduct = (left, right, name) => {
    const product = left * right;
    requireSafeCount(product, name);
    return product;
  };
  const snappedFloor = value => {
    const nearest = Math.round(value);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
    return Math.floor(Math.abs(value - nearest) <= tolerance ? nearest : value);
  };
  const parseCell = (key, index) => {
    if (typeof key !== 'string' || !CELL_KEY.test(key)) {
      throw new TypeError(`room.cells entry ${index} must be an integer "x,y" key.`);
    }
    const [x, y] = key.split(',').map(Number);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      throw new RangeError(`room.cells entry ${index} coordinates must be safe integers.`);
    }
    return [x, y];
  };

  const validateRoomAndBounds = snapshot => {
    requireObject(snapshot, 'snapshot');
    requireObject(snapshot.room, 'snapshot.room');
    const { cells } = snapshot.room;
    if (!(cells instanceof Set)) throw new TypeError('snapshot.room.cells must be a Set.');
    if (cells.size === 0) throw new RangeError('snapshot.room.cells must not be empty.');
    if (cells.size > MAX_ROOM_CELLS) {
      throw new RangeError(`snapshot.room.cells cannot contain more than ${MAX_ROOM_CELLS} cells.`);
    }
    requireFiniteNumber(snapshot.room.absorption, 'snapshot.room.absorption');
    if (snapshot.room.absorption < 0 || snapshot.room.absorption > 1) {
      throw new RangeError('snapshot.room.absorption must be between 0 and 1.');
    }
    requireObject(snapshot.acoustics, 'snapshot.acoustics');
    requirePositiveNumber(snapshot.acoustics.speedOfSound, 'snapshot.acoustics.speedOfSound');

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let index = 0;
    for (const key of cells) {
      const [x, y] = parseCell(key, index);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + 1);
      maxY = Math.max(maxY, y + 1);
      index += 1;
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    if (spanX > MAX_ROOM_SPAN || spanY > MAX_ROOM_SPAN) {
      throw new RangeError(`snapshot.room.cells span cannot exceed ${MAX_ROOM_SPAN} × ${MAX_ROOM_SPAN} m.`);
    }
    return { minX, minY, maxX, maxY, spanX, spanY };
  };

  const resolveGridPolicy = (snapshot, bounds) => {
    const speed = snapshot.acoustics.speedOfSound;
    let dx;
    if (snapshot.solver !== undefined) {
      requireObject(snapshot.solver, 'snapshot.solver');
      if (Object.hasOwn(snapshot.solver, 'dx')) dx = snapshot.solver.dx;
    }
    if (dx === undefined) {
      requireObject(snapshot.analysis, 'snapshot.analysis');
      if (typeof RoomWave.solverPolicy !== 'function') {
        throw new Error('Acoustic solver policy is unavailable.');
      }
      dx = RoomWave.solverPolicy(
        { width: bounds.spanX, height: bounds.spanY },
        snapshot.analysis.quality,
        speed,
      ).dx;
    }
    requirePositiveNumber(dx, 'snapshot.solver.dx');

    const width = Math.ceil(bounds.spanX / dx);
    const height = Math.ceil(bounds.spanY / dx);
    requireSafeCount(width, 'wave grid width');
    requireSafeCount(height, 'wave grid height');
    const cellCount = checkedProduct(width, height, 'wave grid cell count');
    if (cellCount > MAX_WAVE_CELLS) {
      throw new RangeError(
        `Wave grid cell count ${cellCount} exceeds the ${MAX_WAVE_CELLS.toLocaleString('en-US')} cell computational budget.`,
      );
    }
    const dt = 0.9 * dx / (speed * Math.sqrt(2));
    if (!Number.isFinite(dt) || dt <= 0) {
      throw new RangeError('Wave grid time step must be a finite positive derived value.');
    }
    const reliableHz = speed / (10 * dx);
    if (!Number.isFinite(reliableHz) || reliableHz <= 0) {
      throw new RangeError('Wave grid reliable frequency must be a finite positive derived value.');
    }
    return { dx, dt, width, height, cellCount, reliableHz };
  };

  const createWaveGrid = snapshot => {
    const bounds = validateRoomAndBounds(snapshot);
    const policy = resolveGridPolicy(snapshot, bounds);
    const { width, height, cellCount, dx } = policy;
    const inside = new Uint8Array(cellCount);
    const boundary = new Uint8Array(cellCount);
    const neighbors = new Int32Array(checkedProduct(cellCount, 4, 'neighbor entry count'));
    neighbors.fill(-1);

    for (let y = 0; y < height; y += 1) {
      const roomY = snappedFloor(bounds.minY + y * dx);
      for (let x = 0; x < width; x += 1) {
        const roomX = snappedFloor(bounds.minX + x * dx);
        if (snapshot.room.cells.has(`${roomX},${roomY}`)) inside[y * width + x] = 1;
      }
    }

    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!inside[index]) continue;
        let touchesWall = false;
        for (let direction = 0; direction < offsets.length; direction += 1) {
          const [offsetX, offsetY] = offsets[direction];
          const neighborX = x + offsetX;
          const neighborY = y + offsetY;
          const neighbor = neighborX >= 0 && neighborX < width && neighborY >= 0 && neighborY < height
            ? neighborY * width + neighborX
            : -1;
          if (neighbor >= 0 && inside[neighbor]) neighbors[index * 4 + direction] = neighbor;
          else touchesWall = true;
        }
        boundary[index] = Number(touchesWall);
      }
    }

    if (typeof RoomWave.reflectionAmplitude !== 'function') {
      throw new Error('Acoustic reflection math is unavailable.');
    }
    const wallLoss = 1 - RoomWave.reflectionAmplitude(snapshot.room.absorption);
    const boundaryDamping = Math.min(1, AIR_DAMPING + wallLoss);
    return {
      ...policy,
      originX: bounds.minX,
      originY: bounds.minY,
      inside,
      boundary,
      neighbors,
      airDamping: AIR_DAMPING,
      boundaryDamping,
    };
  };

  const normalizeHooks = hooks => {
    if (hooks === undefined) {
      return { isCancelled: () => false, onProgress() {}, async yieldControl() {} };
    }
    requireObject(hooks, 'hooks');
    for (const name of ['isCancelled', 'onProgress', 'yieldControl']) {
      if (typeof hooks[name] !== 'function') throw new TypeError(`hooks.${name} must be a function.`);
    }
    return hooks;
  };
  const rejectIfCancelled = hooks => {
    if (hooks.isCancelled()) throw new Error('Calculation cancelled.');
  };

  const validateFrequency = (snapshot, grid, override) => {
    requireObject(snapshot.analysis, 'snapshot.analysis');
    const frequency = override === undefined ? snapshot.analysis.frequency : override;
    requirePositiveNumber(frequency, 'snapshot.analysis.frequency');
    const allowance = Number.EPSILON * Math.max(frequency, grid.reliableHz) * 4;
    if (frequency - grid.reliableHz > allowance) {
      throw new RangeError(
        `snapshot.analysis.frequency exceeds the ${grid.reliableHz} Hz reliable wave limit.`,
      );
    }
    return frequency;
  };

  const validateSources = (snapshot, grid, frequency) => {
    if (!Array.isArray(snapshot.sources)) throw new TypeError('snapshot.sources must be an array.');
    if (snapshot.sources.length > MAX_SOURCES) {
      throw new RangeError(`snapshot.sources cannot contain more than ${MAX_SOURCES} sources.`);
    }
    for (let index = 0; index < snapshot.sources.length; index += 1) {
      const source = snapshot.sources[index];
      requireObject(source, `snapshot.sources[${index}]`);
      if (!RoomWave.SOURCE_TYPES || !Object.hasOwn(RoomWave.SOURCE_TYPES, source.type)) {
        throw new RangeError(`snapshot.sources[${index}].type is unknown.`);
      }
      for (const key of ['x', 'y', 'gainDb', 'delayMs', 'rotation']) {
        requireFiniteNumber(source[key], `snapshot.sources[${index}].${key}`);
      }
      if (source.polarity !== 'normal' && source.polarity !== 'inverted') {
        throw new RangeError(`snapshot.sources[${index}].polarity must be normal or inverted.`);
      }
      const roomCell = `${snappedFloor(source.x)},${snappedFloor(source.y)}`;
      if (!snapshot.room.cells.has(roomCell)) {
        throw new RangeError(`snapshot.sources[${index}] must be inside the room.`);
      }
      const gain = RoomWave.sourceComplexGain(source, frequency);
      if (!Number.isFinite(gain.real) || !Number.isFinite(gain.imaginary)) {
        throw new RangeError(`snapshot.sources[${index}] produces a non-finite complex gain.`);
      }
    }
  };

  const bilinearDistribution = (grid, sourceX, sourceY) => {
    const gridX = Math.min(grid.width - 1, Math.max(0, (sourceX - grid.originX) / grid.dx));
    const gridY = Math.min(grid.height - 1, Math.max(0, (sourceY - grid.originY) / grid.dx));
    const x0 = Math.floor(gridX);
    const y0 = Math.floor(gridY);
    const x1 = Math.min(grid.width - 1, x0 + 1);
    const y1 = Math.min(grid.height - 1, y0 + 1);
    const tx = gridX - x0;
    const ty = gridY - y0;
    const candidates = [
      [x0, y0, (1 - tx) * (1 - ty)],
      [x1, y0, tx * (1 - ty)],
      [x0, y1, (1 - tx) * ty],
      [x1, y1, tx * ty],
    ];
    const weights = new Map();
    for (const [x, y, weight] of candidates) {
      const index = y * grid.width + x;
      if (weight > 0 && grid.inside[index]) weights.set(index, (weights.get(index) || 0) + weight);
    }
    return weights;
  };

  const sourceDistribution = (grid, source) => {
    const definition = RoomWave.SOURCE_TYPES[source.type];
    if (definition.directivity === 'omni') {
      const weights = bilinearDistribution(grid, source.x, source.y);
      const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
      return total > 0
        ? [...weights].map(([index, weight]) => ({ index, weight: weight / total }))
        : [];
    }

    const weights = new Map();
    const rotation = source.rotation * Math.PI / 180;
    // A grid-aligned point injection is necessarily a monopole: multiplying that one node by
    // directivity only changes global level. This compact eight-point aperture preserves bilinear
    // deposition while giving rotation a spatial pattern that the wave equation can propagate.
    for (let direction = 0; direction < 8; direction += 1) {
      const bearing = direction * Math.PI / 4;
      const patternGain = RoomWave.directionalGain(source.type, bearing - rotation);
      const aperture = bilinearDistribution(
        grid,
        source.x + grid.dx * Math.cos(bearing),
        source.y + grid.dx * Math.sin(bearing),
      );
      for (const [index, weight] of aperture) {
        weights.set(index, (weights.get(index) || 0) + patternGain * weight);
      }
    }
    const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
    return total > 0
      ? [...weights].map(([index, weight]) => ({ index, weight: weight / total }))
      : [];
  };

  const createCoherentDrive = (snapshot, grid, frequency) => {
    const real = new Float64Array(grid.cellCount);
    const imaginary = new Float64Array(grid.cellCount);
    for (const source of snapshot.sources) {
      const gain = RoomWave.sourceComplexGain(source, frequency);
      for (const contribution of sourceDistribution(grid, source)) {
        real[contribution.index] += gain.real * contribution.weight;
        imaginary[contribution.index] += gain.imaginary * contribution.weight;
      }
    }
    // Exact 180-degree cancellation leaves sin(π)-scale residue in IEEE-754. Removing only
    // machine-noise-scale drive avoids turning a physically silent result into a normalized 0 dB map.
    for (let index = 0; index < real.length; index += 1) {
      if (Math.abs(real[index]) < 1e-14) real[index] = 0;
      if (Math.abs(imaginary[index]) < 1e-14) imaginary[index] = 0;
    }
    return { real, imaginary };
  };

  const stepPressure = (grid, previous, current, next, drive, lambdaSquared) => {
    for (let index = 0; index < current.length; index += 1) {
      if (!grid.inside[index]) {
        next[index] = 0;
        continue;
      }
      const center = current[index];
      let laplacian = 0;
      const neighborOffset = index * 4;
      for (let direction = 0; direction < 4; direction += 1) {
        const neighbor = grid.neighbors[neighborOffset + direction];
        laplacian += (neighbor < 0 ? center : current[neighbor]) - center;
      }
      const damping = grid.boundary[index] ? grid.boundaryDamping : grid.airDamping;
      next[index] = (2 - damping) * center
        - (1 - damping) * previous[index]
        + lambdaSquared * laplacian
        + drive[index];
    }
  };

  const checkpoint = async (hooks, phase, completed, total, reportProgress) => {
    if (reportProgress) hooks.onProgress({ phase, completed, total });
    await hooks.yieldControl();
    rejectIfCancelled(hooks);
  };

  const assertFinitePressure = pressure => {
    for (const value of pressure) {
      if (!Number.isFinite(value)) {
        throw new Error('Wave calculation became numerically unstable.');
      }
    }
  };

  const fieldBase = grid => ({
    width: grid.width,
    height: grid.height,
    dx: grid.dx,
    dt: grid.dt,
    originX: grid.originX,
    originY: grid.originY,
    inside: grid.inside,
    reliableHz: grid.reliableHz,
  });

  const solveCoherent = async (snapshot, rawHooks) => {
    const hooks = normalizeHooks(rawHooks);
    rejectIfCancelled(hooks);
    const grid = createWaveGrid(snapshot);
    const frequency = validateFrequency(snapshot, grid);
    validateSources(snapshot, grid, frequency);

    const omega = 2 * Math.PI * frequency;
    const warmupSeconds = Math.max(20 / frequency, 0.35);
    const warmupSteps = Math.ceil(warmupSeconds / grid.dt);
    const lockSteps = Math.ceil((10 / frequency) / grid.dt);
    const totalSteps = warmupSteps + lockSteps;
    if (!Number.isSafeInteger(totalSteps) || totalSteps <= 0 || totalSteps > MAX_TIME_STEPS) {
      throw new RangeError(
        `Coherent solver step count must be a positive safe integer no greater than ${MAX_TIME_STEPS}.`,
      );
    }
    const lambda = snapshot.acoustics.speedOfSound * grid.dt / grid.dx;
    const lambdaSquared = lambda * lambda;
    const sourceDrive = createCoherentDrive(snapshot, grid, frequency);
    let previous = new Float64Array(grid.cellCount);
    let current = new Float64Array(grid.cellCount);
    let next = new Float64Array(grid.cellCount);
    const drive = new Float64Array(grid.cellCount);
    const real = new Float64Array(grid.cellCount);
    const imaginary = new Float64Array(grid.cellCount);

    hooks.onProgress({ phase: 'coherent', completed: 0, total: totalSteps });
    for (let step = 0; step < totalSteps; step += 1) {
      const time = step * grid.dt;
      const cosine = Math.cos(omega * time);
      const sine = Math.sin(omega * time);
      for (let index = 0; index < drive.length; index += 1) {
        drive[index] = DRIVE_SCALE
          * (sourceDrive.real[index] * cosine + sourceDrive.imaginary[index] * sine);
      }
      stepPressure(grid, previous, current, next, drive, lambdaSquared);
      const recycled = previous;
      previous = current;
      current = next;
      next = recycled;

      if (step >= warmupSteps) {
        const sampleTime = (step + 1) * grid.dt;
        const sampleCosine = Math.cos(omega * sampleTime);
        const sampleSine = Math.sin(omega * sampleTime);
        for (let index = 0; index < current.length; index += 1) {
          real[index] += current[index] * sampleCosine;
          imaginary[index] += current[index] * sampleSine;
        }
      }
      const completed = step + 1;
      if (completed % YIELD_STEPS === 0 || completed === totalSteps) {
        assertFinitePressure(current);
        await checkpoint(
          hooks,
          'coherent',
          completed,
          totalSteps,
          completed % PROGRESS_STEPS === 0 || completed === totalSteps,
        );
      }
    }

    const lockScale = 2 / lockSteps;
    const magnitude = new Float64Array(grid.cellCount);
    const phase = new Float64Array(grid.cellCount);
    let maximum = 0;
    for (let index = 0; index < magnitude.length; index += 1) {
      if (!grid.inside[index]) continue;
      real[index] *= lockScale;
      imaginary[index] *= lockScale;
      const value = Math.hypot(real[index], imaginary[index]);
      if (!Number.isFinite(value)) throw new Error('Wave lock-in produced a non-finite magnitude.');
      magnitude[index] = value;
      phase[index] = value === 0 ? 0 : Math.atan2(imaginary[index], real[index]);
      maximum = Math.max(maximum, value);
    }
    const levelDb = new Float64Array(grid.cellCount);
    levelDb.fill(DISPLAY_FLOOR_DB);
    if (maximum > 0 && Number.isFinite(maximum)) {
      for (let index = 0; index < levelDb.length; index += 1) {
        if (!grid.inside[index] || magnitude[index] === 0) continue;
        levelDb[index] = Math.max(
          DISPLAY_FLOOR_DB,
          Math.min(0, 20 * Math.log10(magnitude[index] / maximum)),
        );
      }
    }
    return { ...fieldBase(grid), frequency, real, imaginary, magnitude, phase, levelDb };
  };

  const solveBroadbandImpulse = async (snapshot, rawHooks) => {
    const hooks = normalizeHooks(rawHooks);
    rejectIfCancelled(hooks);
    const grid = createWaveGrid(snapshot);
    const centerFrequency = Math.min(80, grid.reliableHz * 0.35);
    validateSources(snapshot, grid, centerFrequency);
    const totalSteps = Math.ceil(0.6 / grid.dt);
    if (!Number.isSafeInteger(totalSteps) || totalSteps <= 0 || totalSteps > MAX_TIME_STEPS) {
      throw new RangeError(
        `Broadband solver step count must be a positive safe integer no greater than ${MAX_TIME_STEPS}.`,
      );
    }
    const lambda = snapshot.acoustics.speedOfSound * grid.dt / grid.dx;
    const lambdaSquared = lambda * lambda;
    let previous = new Float64Array(grid.cellCount);
    let current = new Float64Array(grid.cellCount);
    let next = new Float64Array(grid.cellCount);
    const drive = new Float64Array(grid.cellCount);
    const energy = new Float64Array(grid.cellCount);
    const sources = snapshot.sources.map(source => {
      const responseDb = RoomWave.sourceResponseDb(source.type, centerFrequency);
      const amplitude = responseDb === -Infinity
        ? 0
        : 10 ** ((responseDb + source.gainDb) / 20)
          * (source.polarity === 'inverted' ? -1 : 1);
      return {
        amplitude,
        delaySeconds: source.delayMs / 1000,
        distribution: sourceDistribution(grid, source),
      };
    });
    const pulseCenter = 4 / centerFrequency;

    hooks.onProgress({ phase: 'broadband impulse', completed: 0, total: totalSteps });
    for (let step = 0; step < totalSteps; step += 1) {
      drive.fill(0);
      const time = step * grid.dt;
      for (const source of sources) {
        const relativeTime = time - source.delaySeconds - pulseCenter;
        const squared = (Math.PI * centerFrequency * relativeTime) ** 2;
        const pulse = source.amplitude * (1 - 2 * squared) * Math.exp(-squared);
        for (const contribution of source.distribution) {
          drive[contribution.index] += DRIVE_SCALE * pulse * contribution.weight;
        }
      }
      stepPressure(grid, previous, current, next, drive, lambdaSquared);
      const recycled = previous;
      previous = current;
      current = next;
      next = recycled;
      for (let index = 0; index < current.length; index += 1) {
        if (grid.inside[index]) energy[index] += current[index] * current[index] * grid.dt;
      }
      const completed = step + 1;
      if (completed % YIELD_STEPS === 0 || completed === totalSteps) {
        assertFinitePressure(current);
        await checkpoint(
          hooks,
          'broadband impulse',
          completed,
          totalSteps,
          completed % PROGRESS_STEPS === 0 || completed === totalSteps,
        );
      }
    }

    let maximum = 0;
    for (const value of energy) {
      if (!Number.isFinite(value)) throw new Error('Broadband solver produced non-finite energy.');
      maximum = Math.max(maximum, value);
    }
    if (maximum > 0 && Number.isFinite(maximum)) {
      for (let index = 0; index < energy.length; index += 1) energy[index] /= maximum;
    }
    return { ...fieldBase(grid), centerFrequency, energy };
  };

  const bilinear = (values, field, x, y, name) => {
    if (!ArrayBuffer.isView(values) || values.length !== field.width * field.height) {
      throw new RangeError(`${name} must contain exactly width * height values.`);
    }
    const gridX = Math.min(field.width - 1, Math.max(0, (x - field.originX) / field.dx));
    const gridY = Math.min(field.height - 1, Math.max(0, (y - field.originY) / field.dx));
    const x0 = Math.floor(gridX);
    const y0 = Math.floor(gridY);
    const x1 = Math.min(field.width - 1, x0 + 1);
    const y1 = Math.min(field.height - 1, y0 + 1);
    const tx = gridX - x0;
    const ty = gridY - y0;
    return values[y0 * field.width + x0] * (1 - tx) * (1 - ty)
      + values[y0 * field.width + x1] * tx * (1 - ty)
      + values[y1 * field.width + x0] * (1 - tx) * ty
      + values[y1 * field.width + x1] * tx * ty;
  };

  const sampleField = (field, x, y) => {
    requireObject(field, 'field');
    requireSafeCount(field.width, 'field.width');
    requireSafeCount(field.height, 'field.height');
    checkedProduct(field.width, field.height, 'field cell count');
    requirePositiveNumber(field.dx, 'field.dx');
    requireFiniteNumber(field.originX, 'field.originX');
    requireFiniteNumber(field.originY, 'field.originY');
    requireFiniteNumber(x, 'x');
    requireFiniteNumber(y, 'y');
    const sampled = {};
    for (const key of ['levelDb', 'energy']) {
      if (field[key] !== undefined) sampled[key] = bilinear(field[key], field, x, y, `field.${key}`);
    }
    if (field.real !== undefined || field.imaginary !== undefined) {
      if (field.real === undefined || field.imaginary === undefined) {
        throw new TypeError('field.real and field.imaginary must be provided together.');
      }
      sampled.real = bilinear(field.real, field, x, y, 'field.real');
      sampled.imaginary = bilinear(field.imaginary, field, x, y, 'field.imaginary');
      sampled.magnitude = Math.hypot(sampled.real, sampled.imaginary);
      sampled.phase = sampled.magnitude === 0 ? 0 : Math.atan2(sampled.imaginary, sampled.real);
    }
    return sampled;
  };

  const scanResponse = async (snapshot, frequencies, rawHooks) => {
    const hooks = normalizeHooks(rawHooks);
    rejectIfCancelled(hooks);
    if (!Array.isArray(frequencies) || frequencies.length === 0) {
      throw new TypeError('frequencies must be a nonempty array.');
    }
    if (frequencies.length > 512) throw new RangeError('frequencies cannot contain more than 512 values.');
    frequencies.forEach((frequency, index) => requirePositiveNumber(frequency, `frequencies[${index}]`));
    const results = [];
    hooks.onProgress({ phase: 'frequency scan', completed: 0, total: frequencies.length });
    for (let index = 0; index < frequencies.length; index += 1) {
      rejectIfCancelled(hooks);
      const frequency = frequencies[index];
      const field = await solveCoherent({
        ...snapshot,
        analysis: { ...snapshot.analysis, frequency },
      }, {
        isCancelled: hooks.isCancelled,
        onProgress() {},
        yieldControl: hooks.yieldControl,
      });
      let energy = 0;
      let count = 0;
      for (let cell = 0; cell < field.magnitude.length; cell += 1) {
        if (!field.inside[cell]) continue;
        energy += field.magnitude[cell] * field.magnitude[cell];
        count += 1;
      }
      results.push({ frequency, energy: count === 0 ? 0 : energy / count });
      hooks.onProgress({
        phase: 'frequency scan',
        completed: index + 1,
        total: frequencies.length,
      });
    }
    return results;
  };

  return {
    createWaveGrid,
    solveCoherent,
    solveBroadbandImpulse,
    sampleField,
    scanResponse,
  };
});
