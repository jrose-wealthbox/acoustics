(function (root, factory) {
  const api = factory();
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function () {
  const QUALITY_DX = Object.freeze({ fast: 0.15, standard: 0.075, high: 0.05 });
  const MAX_MODE_CANDIDATES = 160000;

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
  const requireFinitePositiveDerived = (value, name) => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a finite positive derived value.`);
    }
  };
  const requireFiniteNonnegativeDerived = (value, name) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a finite nonnegative derived value.`);
    }
  };
  const requirePositiveSafeInteger = (value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  };

  const wavelength = (frequency, speed) => {
    requirePositiveNumber(frequency, 'frequency');
    requirePositiveNumber(speed, 'speed');
    const result = speed / frequency;
    requireFinitePositiveDerived(result, 'wavelength');
    return result;
  };
  const reflectionAmplitude = absorption => {
    requireFiniteNumber(absorption, 'absorption');
    if (absorption < 0 || absorption > 1) {
      throw new RangeError('absorption must be between 0 and 1.');
    }
    return Math.sqrt(1 - absorption);
  };

  const solverPolicy = (roomBounds, quality, speed) => {
    requireObject(roomBounds, 'roomBounds');
    requirePositiveNumber(roomBounds.width, 'roomBounds.width');
    requirePositiveNumber(roomBounds.height, 'roomBounds.height');
    if (!Object.hasOwn(QUALITY_DX, quality)) {
      throw new RangeError('quality must be fast, standard, or high.');
    }
    requirePositiveNumber(speed, 'speed');

    const { width, height } = roomBounds;
    const dx = QUALITY_DX[quality];
    const dt = 0.9 * dx / (speed * Math.sqrt(2));
    const widthCells = Math.ceil(width / dx);
    const heightCells = Math.ceil(height / dx);
    requirePositiveSafeInteger(widthCells, 'widthCells');
    requirePositiveSafeInteger(heightCells, 'heightCells');
    const cellCount = widthCells * heightCells;
    requirePositiveSafeInteger(cellCount, 'cellCount');
    requireFinitePositiveDerived(dt, 'dt');
    const reliableHz = speed / (10 * dx);
    requireFinitePositiveDerived(reliableHz, 'reliableHz');
    return {
      dx,
      dt,
      widthCells,
      heightCells,
      cellCount,
      stabilityMargin: 0.9,
      reliableHz,
      allowed: cellCount <= 160000,
    };
  };

  const rectangularModes = (dimensions, maxHz, speed) => {
    requireObject(dimensions, 'dimensions');
    requirePositiveNumber(dimensions.width, 'dimensions.width');
    requirePositiveNumber(dimensions.depth, 'dimensions.depth');
    requirePositiveNumber(dimensions.height, 'dimensions.height');
    requirePositiveNumber(maxHz, 'maxHz');
    requirePositiveNumber(speed, 'speed');

    const halfSpeed = speed / 2;
    requireFinitePositiveDerived(halfSpeed, 'rectangularModes derived half speed');
    for (const dimensionName of ['width', 'depth', 'height']) {
      const firstMode = halfSpeed / dimensions[dimensionName];
      requireFinitePositiveDerived(
        firstMode,
        `dimensions.${dimensionName} first mode frequency`,
      );
    }

    const candidateScale = maxHz / halfSpeed;
    requireFinitePositiveDerived(candidateScale, 'rectangularModes derived candidate scale');
    const candidateLimit = (dimensionName, axisName) => {
      const rawLimit = candidateScale * dimensions[dimensionName];
      requireFinitePositiveDerived(rawLimit, `modal candidate ${axisName} limit`);
      const limit = Math.ceil(rawLimit);
      requirePositiveSafeInteger(limit, `modal candidate ${axisName} limit`);
      return limit;
    };

    const modes = [];
    // Ceil admits at most one extra index per axis for the cutoff check to reject, and avoids
    // dropping a boundary mode when its analytically integral ratio rounds just below an integer.
    const maxNx = candidateLimit('width', 'nx');
    const maxNy = candidateLimit('depth', 'ny');
    const maxNz = candidateLimit('height', 'nz');
    const candidateCount = (maxNx + 1) * (maxNy + 1) * (maxNz + 1);
    // Modal enumeration allocates one object per retained tuple; bounding candidates at the
    // wave-cell gate keeps malformed direct calls from monopolizing the main thread or worker.
    if (!Number.isSafeInteger(candidateCount) || candidateCount > MAX_MODE_CANDIDATES) {
      throw new RangeError(
        `modal candidate count must be a safe integer no greater than ${MAX_MODE_CANDIDATES}.`,
      );
    }

    for (let nx = 0; nx <= maxNx; nx += 1) {
      for (let ny = 0; ny <= maxNy; ny += 1) {
        for (let nz = 0; nz <= maxNz; nz += 1) {
          const nonZeroIndices = Number(nx > 0) + Number(ny > 0) + Number(nz > 0);
          if (nonZeroIndices === 0) continue;

          const xRatio = nx / dimensions.width;
          const yRatio = ny / dimensions.depth;
          const zRatio = nz / dimensions.height;
          requireFiniteNonnegativeDerived(xRatio, 'modal nx/width ratio');
          requireFiniteNonnegativeDerived(yRatio, 'modal ny/depth ratio');
          requireFiniteNonnegativeDerived(zRatio, 'modal nz/height ratio');
          const magnitude = Math.hypot(xRatio, yRatio, zRatio);
          requireFinitePositiveDerived(magnitude, 'modal ratio magnitude');
          const frequency = halfSpeed * magnitude;
          requireFinitePositiveDerived(frequency, 'modal frequency');
          // Equivalent modal formulas can straddle a cutoff by a few ULPs. Scale the allowance
          // to the compared frequencies so tiny cutoffs never inherit a material absolute floor.
          const cutoffScale = Math.max(Math.abs(frequency), Math.abs(maxHz));
          const cutoffError = Math.max(
            Number.MIN_VALUE,
            Number.EPSILON * cutoffScale * 4,
          );
          if (frequency - maxHz > cutoffError) continue;

          modes.push({
            nx,
            ny,
            nz,
            frequency,
            type: ['axial', 'tangential', 'oblique'][nonZeroIndices - 1],
          });
        }
      }
    }
    return modes.sort((left, right) => (
      left.frequency - right.frequency
      || left.nx - right.nx
      || left.ny - right.ny
      || left.nz - right.nz
    ));
  };

  const modalTolerance = (expectedHz, transformBinHz) => {
    requirePositiveNumber(expectedHz, 'expectedHz');
    requirePositiveNumber(transformBinHz, 'transformBinHz');
    return Math.max(transformBinHz, expectedHz * 0.05);
  };

  return {
    wavelength,
    reflectionAmplitude,
    solverPolicy,
    rectangularModes,
    modalTolerance,
  };
});
