(function (root, factory) {
  const api = factory();
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function () {
  const QUALITY_DX = Object.freeze({ fast: 0.15, standard: 0.075, high: 0.05 });

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

  const wavelength = (frequency, speed) => {
    requirePositiveNumber(frequency, 'frequency');
    requirePositiveNumber(speed, 'speed');
    return speed / frequency;
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
    return {
      dx,
      dt,
      widthCells,
      heightCells,
      cellCount: widthCells * heightCells,
      stabilityMargin: 0.9,
      reliableHz: speed / (10 * dx),
      allowed: widthCells * heightCells <= 160000,
    };
  };

  const rectangularModes = (dimensions, maxHz, speed) => {
    requireObject(dimensions, 'dimensions');
    requirePositiveNumber(dimensions.width, 'dimensions.width');
    requirePositiveNumber(dimensions.depth, 'dimensions.depth');
    requirePositiveNumber(dimensions.height, 'dimensions.height');
    requirePositiveNumber(maxHz, 'maxHz');
    requirePositiveNumber(speed, 'speed');

    const modes = [];
    // Ceil admits at most one extra index per axis for the cutoff check to reject, and avoids
    // dropping a boundary mode when its analytically integral ratio rounds just below an integer.
    const maxNx = Math.ceil(2 * maxHz * dimensions.width / speed);
    const maxNy = Math.ceil(2 * maxHz * dimensions.depth / speed);
    const maxNz = Math.ceil(2 * maxHz * dimensions.height / speed);

    for (let nx = 0; nx <= maxNx; nx += 1) {
      for (let ny = 0; ny <= maxNy; ny += 1) {
        for (let nz = 0; nz <= maxNz; nz += 1) {
          const nonZeroIndices = Number(nx > 0) + Number(ny > 0) + Number(nz > 0);
          if (nonZeroIndices === 0) continue;

          const frequency = speed / 2 * Math.sqrt(
            (nx / dimensions.width) ** 2
            + (ny / dimensions.depth) ** 2
            + (nz / dimensions.height) ** 2,
          );
          // Equivalent modal formulas can straddle a cutoff by a few ULPs, so preserve an
          // analytically inclusive boundary without admitting meaningfully higher modes.
          const cutoffError = Number.EPSILON * Math.max(1, frequency, maxHz) * 4;
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
