(function (root, factory) {
  const api = factory();
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function () {
  const MAX_FIELD_CELLS = 160000;
  const MAX_BANDS = 512;
  const MAX_SOURCES = 14;
  const MAX_VERTICAL_MODES = 256;
  const MAX_DIAGNOSTIC_MODES = 1024;
  const MAX_DIAGNOSTIC_PATHS = 4096;
  const DEFAULT_SPEED_OF_SOUND = 343;
  const MAP_RESOLUTIONS = new Set([0.1, 0.25, 0.5, 1]);
  const SCALAR_FIELDS = ['levelDb', 'energy', 'magnitude'];

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
  const requireNonnegativeNumber = (value, name) => {
    requireFiniteNumber(value, name);
    if (value < 0) throw new RangeError(`${name} must be nonnegative.`);
  };
  const requireSafeCount = (value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  };
  const checkedCellCount = (width, height, name) => {
    requireSafeCount(width, `${name}.width`);
    requireSafeCount(height, `${name}.height`);
    if (width > Math.floor(Number.MAX_SAFE_INTEGER / height)) {
      throw new RangeError(`${name} width * height must be a safe integer.`);
    }
    const count = width * height;
    if (count > MAX_FIELD_CELLS) {
      throw new RangeError(`${name} cell count cannot exceed ${MAX_FIELD_CELLS.toLocaleString('en-US')}.`);
    }
    return count;
  };
  const isNumericArray = value => (
    Array.isArray(value)
    || (ArrayBuffer.isView(value) && !(value instanceof DataView))
  );
  const validateNumericArray = (values, length, name, { nonnegative = false } = {}) => {
    if (!isNumericArray(values) || values.length !== length) {
      throw new RangeError(`${name} must contain exactly width * height values.`);
    }
    for (let index = 0; index < values.length; index += 1) {
      requireFiniteNumber(values[index], `${name}[${index}]`);
      if (nonnegative && values[index] < 0) {
        throw new RangeError(`${name}[${index}] must be nonnegative.`);
      }
    }
  };

  const combineBroadbandBands = bands => {
    if (!Array.isArray(bands) || bands.length === 0) {
      throw new TypeError('bands must be a nonempty array.');
    }
    if (bands.length > MAX_BANDS) {
      throw new RangeError(`bands cannot contain more than ${MAX_BANDS} entries.`);
    }

    let length = null;
    let totalWeight = 0;
    const prepared = bands.map((band, bandIndex) => {
      requireObject(band, `bands[${bandIndex}]`);
      const arrays = band.energy === undefined
        ? [
          ['waveEnergy', band.waveEnergy],
          ['rayEnergy', band.rayEnergy],
        ]
        : [['energy', band.energy]];
      if (arrays.some(([, values]) => !isNumericArray(values))) {
        throw new TypeError(`bands[${bandIndex}] must provide numeric energy arrays.`);
      }
      const bandLength = arrays[0][1].length;
      if (length === null) {
        requireSafeCount(bandLength, 'band energy length');
        if (bandLength > MAX_FIELD_CELLS) {
          throw new RangeError(`band energy length cannot exceed ${MAX_FIELD_CELLS.toLocaleString('en-US')}.`);
        }
        length = bandLength;
      }
      if (bandLength !== length || arrays.some(([, values]) => values.length !== length)) {
        throw new RangeError('All band energy arrays must have the same length.');
      }
      for (const [key, values] of arrays) {
        for (let index = 0; index < values.length; index += 1) {
          requireFiniteNumber(values[index], `bands[${bandIndex}].${key}[${index}]`);
          if (values[index] < 0) {
            throw new RangeError(`bands[${bandIndex}].${key}[${index}] energy must be nonnegative.`);
          }
        }
      }
      const weight = band.weight ?? 1;
      requireNonnegativeNumber(weight, `bands[${bandIndex}].weight`);
      let responseWeight = band.responseWeight;
      if (responseWeight === undefined && band.responseDb !== undefined) {
        requireFiniteNumber(band.responseDb, `bands[${bandIndex}].responseDb`);
        responseWeight = 10 ** (band.responseDb / 10);
      }
      responseWeight ??= 1;
      requireNonnegativeNumber(responseWeight, `bands[${bandIndex}].responseWeight`);
      const effectiveWeight = weight * responseWeight;
      if (!Number.isFinite(effectiveWeight)) {
        throw new RangeError(`bands[${bandIndex}] effective weight must be finite.`);
      }
      totalWeight += effectiveWeight;
      if (!Number.isFinite(totalWeight)) {
        throw new RangeError('Broadband total weight must be finite.');
      }
      let rayWeight = null;
      if (band.energy === undefined) {
        requireObject(band.overlap, `bands[${bandIndex}].overlap`);
        requirePositiveNumber(band.frequency, `bands[${bandIndex}].frequency`);
        requirePositiveNumber(band.overlap.startHz, `bands[${bandIndex}].overlap.startHz`);
        requirePositiveNumber(band.overlap.endHz, `bands[${bandIndex}].overlap.endHz`);
        if (band.overlap.endHz <= band.overlap.startHz) {
          throw new RangeError(`bands[${bandIndex}].overlap.endHz must be greater than startHz.`);
        }
        const progress = Math.min(1, Math.max(0, (
          band.frequency - band.overlap.startHz
        ) / (band.overlap.endHz - band.overlap.startHz)));
        // Raised-cosine weights keep both energy models continuous through their overlap while
        // preserving unit total weight, so the overlap is never counted twice.
        rayWeight = (1 - Math.cos(Math.PI * progress)) / 2;
      }
      return { band, effectiveWeight, rayWeight };
    });
    if (!(totalWeight > 0)) {
      throw new RangeError('Broadband total weight must be greater than zero.');
    }

    const result = new Float64Array(length);
    for (const { band, effectiveWeight, rayWeight } of prepared) {
      if (effectiveWeight === 0) continue;
      const normalizedWeight = effectiveWeight / totalWeight;
      for (let index = 0; index < result.length; index += 1) {
        const energy = band.energy === undefined
          ? band.waveEnergy[index] * (1 - rayWeight) + band.rayEnergy[index] * rayWeight
          : band.energy[index];
        if (!Number.isFinite(energy) || energy < 0) {
          throw new RangeError(`bands energy at index ${index} must be finite and nonnegative.`);
        }
        result[index] += energy * normalizedWeight;
        if (!Number.isFinite(result[index])) {
          throw new RangeError(`Combined broadband energy at index ${index} must be finite.`);
        }
      }
    }
    return result;
  };

  const firstVerticalMode = (height, speed) => {
    requirePositiveNumber(height, 'height');
    requirePositiveNumber(speed, 'speed');
    const frequency = speed / (2 * height);
    if (!Number.isFinite(frequency) || frequency <= 0) {
      throw new RangeError('First vertical mode must be a finite positive derived value.');
    }
    return frequency;
  };

  const verticalTransfer = (room, sources, listeningPoint, frequencies) => {
    requireObject(room, 'room');
    requireFiniteNumber(room.ceilingHeight, 'room.ceilingHeight');
    if (room.ceilingHeight < 2 || room.ceilingHeight > 10) {
      throw new RangeError('room.ceilingHeight must be between 2 and 10 m.');
    }
    requireFiniteNumber(room.absorption, 'room.absorption');
    if (room.absorption < 0 || room.absorption > 1) {
      throw new RangeError('room.absorption must be between 0 and 1.');
    }
    const speed = room.speedOfSound ?? DEFAULT_SPEED_OF_SOUND;
    requirePositiveNumber(speed, 'room.speedOfSound');
    requireObject(listeningPoint, 'listeningPoint');
    requireFiniteNumber(listeningPoint.z, 'listeningPoint.z');
    if (listeningPoint.z < 0 || listeningPoint.z > room.ceilingHeight) {
      throw new RangeError('listeningPoint.z must be between the floor and ceiling.');
    }
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new TypeError('sources must be a nonempty array.');
    }
    if (sources.length > MAX_SOURCES) {
      throw new RangeError(`sources cannot contain more than ${MAX_SOURCES} entries.`);
    }
    const preparedSources = sources.map((source, index) => {
      requireObject(source, `sources[${index}]`);
      requireFiniteNumber(source.z, `sources[${index}].z`);
      if (source.z < 0 || source.z > room.ceilingHeight) {
        throw new RangeError(`sources[${index}].z must be between the floor and ceiling.`);
      }
      const amplitude = source.weight ?? (
        source.gainDb === undefined ? 1 : 10 ** (source.gainDb / 20)
      );
      requireNonnegativeNumber(amplitude, `sources[${index}] amplitude`);
      if (source.delayMs !== undefined) requireFiniteNumber(source.delayMs, `sources[${index}].delayMs`);
      if (
        source.polarity !== undefined
        && source.polarity !== 'normal'
        && source.polarity !== 'inverted'
      ) throw new RangeError(`sources[${index}].polarity must be normal or inverted.`);
      return { ...source, amplitude };
    });
    if (!Array.isArray(frequencies) || frequencies.length === 0) {
      throw new TypeError('frequencies must be a nonempty array.');
    }
    if (frequencies.length > MAX_BANDS) {
      throw new RangeError(`frequencies cannot contain more than ${MAX_BANDS} values.`);
    }
    frequencies.forEach((frequency, index) => (
      requirePositiveNumber(frequency, `frequencies[${index}]`)
    ));

    const highestFrequency = Math.max(...frequencies);
    const firstMode = firstVerticalMode(room.ceilingHeight, speed);
    const modeCount = Math.ceil(highestFrequency / firstMode) + 4;
    if (!Number.isSafeInteger(modeCount) || modeCount > MAX_VERTICAL_MODES) {
      throw new RangeError(`Vertical mode count cannot exceed ${MAX_VERTICAL_MODES}.`);
    }
    // Real rooms never have an infinite-Q resonance, even at a nominal absorption of zero.
    // The small loss floor keeps this analytical approximation finite; boundary absorption then
    // broadens resonances monotonically without pretending to be a measured decay model.
    const dampingRatio = 0.01 + room.absorption * 0.2;
    const result = new Float64Array(frequencies.length);
    for (let frequencyIndex = 0; frequencyIndex < frequencies.length; frequencyIndex += 1) {
      const frequency = frequencies[frequencyIndex];
      let totalReal = 0;
      let totalImaginary = 0;
      for (let mode = 0; mode <= modeCount; mode += 1) {
        const listenerShape = mode === 0
          ? 1
          : Math.cos(Math.PI * mode * listeningPoint.z / room.ceilingHeight);
        let sourceReal = 0;
        let sourceImaginary = 0;
        for (const source of preparedSources) {
          const sourceShape = mode === 0
            ? 1
            : Math.cos(Math.PI * mode * source.z / room.ceilingHeight);
          const phase = 2 * Math.PI * frequency * ((source.delayMs ?? 0) / 1000)
            + (source.polarity === 'inverted' ? Math.PI : 0);
          sourceReal += source.amplitude * sourceShape * Math.cos(phase);
          sourceImaginary += source.amplitude * sourceShape * Math.sin(phase);
        }
        sourceReal /= preparedSources.length;
        sourceImaginary /= preparedSources.length;
        if (mode === 0) {
          totalReal += sourceReal;
          totalImaginary += sourceImaginary;
          continue;
        }
        const modeFrequency = mode * firstMode;
        const ratio = frequency / modeFrequency;
        const denominatorReal = 1 - ratio * ratio;
        const denominatorImaginary = 2 * dampingRatio * ratio;
        const denominatorMagnitude = denominatorReal * denominatorReal
          + denominatorImaginary * denominatorImaginary;
        const shapeScale = listenerShape / denominatorMagnitude;
        totalReal += shapeScale * (
          sourceReal * denominatorReal + sourceImaginary * denominatorImaginary
        );
        totalImaginary += shapeScale * (
          sourceImaginary * denominatorReal - sourceReal * denominatorImaginary
        );
      }
      const energy = totalReal * totalReal + totalImaginary * totalImaginary;
      if (!Number.isFinite(energy) || energy < 0) {
        throw new RangeError(`Vertical transfer at frequencies[${frequencyIndex}] must be finite.`);
      }
      result[frequencyIndex] = energy;
    }
    return result;
  };

  const validateField = field => {
    requireObject(field, 'field');
    const cellCount = checkedCellCount(field.width, field.height, 'field');
    const spacing = field.dx ?? field.resolution;
    requirePositiveNumber(spacing, 'field spacing');
    if (
      field.dx !== undefined
      && field.resolution !== undefined
      && Math.abs(field.dx - field.resolution) > Number.EPSILON * Math.max(field.dx, field.resolution) * 8
    ) throw new RangeError('field.dx and field.resolution must describe the same spacing.');
    const originX = field.originX ?? 0;
    const originY = field.originY ?? 0;
    requireFiniteNumber(originX, 'field.originX');
    requireFiniteNumber(originY, 'field.originY');
    let valueFieldCount = 0;
    for (const key of [...SCALAR_FIELDS, 'phase', 'real', 'imaginary']) {
      if (field[key] === undefined) continue;
      validateNumericArray(field[key], cellCount, `field.${key}`, { nonnegative: key === 'energy' });
      valueFieldCount += 1;
    }
    if ((field.real === undefined) !== (field.imaginary === undefined)) {
      throw new TypeError('field.real and field.imaginary must be provided together.');
    }
    if (field.inside !== undefined) {
      validateNumericArray(field.inside, cellCount, 'field.inside', { nonnegative: true });
    }
    if (valueFieldCount === 0) throw new TypeError('field must provide at least one sample array.');
    const maxX = originX + (field.width - 1) * spacing;
    const maxY = originY + (field.height - 1) * spacing;
    if (!Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      throw new RangeError('field bounds must be finite derived values.');
    }
    return { cellCount, spacing, originX, originY, maxX, maxY };
  };

  const fieldMetadata = field => {
    const metadata = validateField(field);
    const cellBinned = field.resolution !== undefined && field.dx === undefined;
    const sampleOffset = cellBinned ? metadata.spacing / 2 : 0;
    const sampleMinX = metadata.originX + sampleOffset;
    const sampleMinY = metadata.originY + sampleOffset;
    const sampleMaxX = sampleMinX + (field.width - 1) * metadata.spacing;
    const sampleMaxY = sampleMinY + (field.height - 1) * metadata.spacing;
    const extentMaxX = metadata.originX
      + (cellBinned ? field.width : field.width - 1) * metadata.spacing;
    const extentMaxY = metadata.originY
      + (cellBinned ? field.height : field.height - 1) * metadata.spacing;
    if (![sampleMinX, sampleMinY, sampleMaxX, sampleMaxY, extentMaxX, extentMaxY].every(Number.isFinite)) {
      throw new RangeError('Field metadata bounds must be finite derived values.');
    }
    return {
      width: field.width,
      height: field.height,
      cellCount: metadata.cellCount,
      spacing: metadata.spacing,
      layout: cellBinned ? 'cell-binned' : 'point-sampled',
      originX: metadata.originX,
      originY: metadata.originY,
      sampleMinX,
      sampleMinY,
      sampleMaxX,
      sampleMaxY,
      extentMinX: metadata.originX,
      extentMinY: metadata.originY,
      extentMaxX,
      extentMaxY,
    };
  };

  const interpolationCoordinates = (field, metadata, point) => {
    requireObject(point, 'point');
    requireFiniteNumber(point.x, 'point.x');
    requireFiniteNumber(point.y, 'point.y');
    const tolerance = Number.EPSILON * Math.max(
      1,
      Math.abs(metadata.originX),
      Math.abs(metadata.originY),
      Math.abs(metadata.maxX),
      Math.abs(metadata.maxY),
    ) * 8;
    if (
      point.x < metadata.originX - tolerance
      || point.x > metadata.maxX + tolerance
      || point.y < metadata.originY - tolerance
      || point.y > metadata.maxY + tolerance
    ) throw new RangeError('point must be inside the field bounds.');
    const gridX = Math.min(field.width - 1, Math.max(0, (point.x - metadata.originX) / metadata.spacing));
    const gridY = Math.min(field.height - 1, Math.max(0, (point.y - metadata.originY) / metadata.spacing));
    const x0 = Math.floor(gridX);
    const y0 = Math.floor(gridY);
    return {
      x0,
      y0,
      x1: Math.min(field.width - 1, x0 + 1),
      y1: Math.min(field.height - 1, y0 + 1),
      tx: gridX - x0,
      ty: gridY - y0,
    };
  };

  const bilinear = (values, width, coordinates) => {
    const {
      x0, y0, x1, y1, tx, ty,
    } = coordinates;
    const value = values[y0 * width + x0] * (1 - tx) * (1 - ty)
      + values[y0 * width + x1] * tx * (1 - ty)
      + values[y1 * width + x0] * (1 - tx) * ty
      + values[y1 * width + x1] * tx * ty;
    if (!Number.isFinite(value)) throw new RangeError('Bilinear sample must be finite.');
    return value;
  };

  const bilinearPhase = (values, width, coordinates) => {
    const {
      x0, y0, x1, y1, tx, ty,
    } = coordinates;
    const entries = [
      [values[y0 * width + x0], (1 - tx) * (1 - ty)],
      [values[y0 * width + x1], tx * (1 - ty)],
      [values[y1 * width + x0], (1 - tx) * ty],
      [values[y1 * width + x1], tx * ty],
    ];
    let cosine = 0;
    let sine = 0;
    for (const [phase, weight] of entries) {
      cosine += Math.cos(phase) * weight;
      sine += Math.sin(phase) * weight;
    }
    return Math.hypot(cosine, sine) <= Number.EPSILON ? 0 : Math.atan2(sine, cosine);
  };

  const sampleValidatedField = (field, metadata, point) => {
    const coordinates = interpolationCoordinates(field, metadata, point);
    const sampled = {};
    for (const key of SCALAR_FIELDS) {
      if (field[key] !== undefined) sampled[key] = bilinear(field[key], field.width, coordinates);
    }
    if (field.real !== undefined) {
      sampled.real = bilinear(field.real, field.width, coordinates);
      sampled.imaginary = bilinear(field.imaginary, field.width, coordinates);
      sampled.magnitude = Math.hypot(sampled.real, sampled.imaginary);
      if (!Number.isFinite(sampled.magnitude)) {
        throw new RangeError('Sampled coherent magnitude must be finite.');
      }
      sampled.phase = sampled.magnitude === 0
        ? 0
        : Math.atan2(sampled.imaginary, sampled.real);
    } else if (field.phase !== undefined) {
      sampled.phase = bilinearPhase(field.phase, field.width, coordinates);
    }
    return sampled;
  };

  const sampleListeningPoint = (result, point) => {
    const metadata = validateField(result);
    return sampleValidatedField(result, metadata, point);
  };

  const outputDimension = (inputCount, inputSpacing, resolution, name) => {
    const span = (inputCount - 1) * inputSpacing;
    const ratio = span / resolution;
    if (!Number.isFinite(ratio)) {
      throw new RangeError(`${name} output cell count must be a finite safe integer.`);
    }
    const nearest = Math.round(ratio);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8;
    // A scalar `resolution` can only describe a uniform square lattice. When the source span is
    // not divisible by that spacing, retain interior lattice points and omit the short terminal
    // remainder rather than clamping a final sample whose advertised coordinate would be false.
    const count = (Math.abs(ratio - nearest) <= tolerance ? nearest : Math.floor(ratio)) + 1;
    requireSafeCount(count, `${name} output cell count`);
    return count;
  };

  const resampleMap = (field, resolution) => {
    const metadata = validateField(field);
    requirePositiveNumber(resolution, 'resolution');
    if (!MAP_RESOLUTIONS.has(resolution)) {
      throw new RangeError('resolution must be 0.1, 0.25, 0.5, or 1 m.');
    }
    const width = outputDimension(field.width, metadata.spacing, resolution, 'map width');
    const height = outputDimension(field.height, metadata.spacing, resolution, 'map height');
    const outputCellCount = checkedCellCount(width, height, 'output map');
    const output = {
      ...field,
      width,
      height,
      dx: resolution,
      resolution,
      originX: metadata.originX,
      originY: metadata.originY,
    };
    for (const key of [...SCALAR_FIELDS, 'phase', 'real', 'imaginary']) delete output[key];
    if (field.inside !== undefined) output.inside = new Uint8Array(outputCellCount);
    for (const key of SCALAR_FIELDS) {
      if (field[key] !== undefined) output[key] = new Float64Array(outputCellCount);
    }
    if (field.real !== undefined) {
      output.real = new Float64Array(outputCellCount);
      output.imaginary = new Float64Array(outputCellCount);
      output.magnitude = new Float64Array(outputCellCount);
      output.phase = new Float64Array(outputCellCount);
    } else if (field.phase !== undefined) output.phase = new Float64Array(outputCellCount);

    // Resampling walks the display grid only after the expensive acoustic calculation. Keeping
    // this loop bounded by the same 160k-cell gate prevents display resolution from becoming a
    // second unbounded analysis workload.
    for (let y = 0; y < height; y += 1) {
      const pointY = metadata.originY + y * resolution;
      for (let x = 0; x < width; x += 1) {
        const pointX = metadata.originX + x * resolution;
        const index = y * width + x;
        const coordinates = interpolationCoordinates(field, metadata, { x: pointX, y: pointY });
        for (const key of SCALAR_FIELDS) {
          if (field[key] !== undefined) output[key][index] = bilinear(field[key], field.width, coordinates);
        }
        if (field.real !== undefined) {
          const real = bilinear(field.real, field.width, coordinates);
          const imaginary = bilinear(field.imaginary, field.width, coordinates);
          const magnitude = Math.hypot(real, imaginary);
          if (!Number.isFinite(magnitude)) throw new RangeError('Resampled magnitude must be finite.');
          output.real[index] = real;
          output.imaginary[index] = imaginary;
          output.magnitude[index] = magnitude;
          output.phase[index] = magnitude === 0 ? 0 : Math.atan2(imaginary, real);
        } else if (field.phase !== undefined) {
          output.phase[index] = bilinearPhase(field.phase, field.width, coordinates);
        }
        if (output.inside !== undefined) {
          const nearestX = Math.min(field.width - 1, Math.round((pointX - metadata.originX) / metadata.spacing));
          const nearestY = Math.min(field.height - 1, Math.round((pointY - metadata.originY) / metadata.spacing));
          output.inside[index] = Number(field.inside[nearestY * field.width + nearestX] > 0);
        }
      }
    }
    return output;
  };

  const normalizedPhaseDifference = (left, right) => {
    const wrapped = Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
    return wrapped;
  };
  const formatFrequency = frequency => `${Number(frequency.toFixed(2))} Hz`;

  const diagnoseListeningPoint = context => {
    requireObject(context, 'context');
    if (context.frequency !== undefined) requirePositiveNumber(context.frequency, 'context.frequency');
    if (context.levelDb !== undefined) requireFiniteNumber(context.levelDb, 'context.levelDb');
    const modes = context.modes ?? context.modalFrequencies ?? [];
    const sources = context.sources ?? context.sourcePhases ?? [];
    const paths = context.paths ?? context.earlyPaths ?? [];
    if (!Array.isArray(modes)) throw new TypeError('context.modes must be an array.');
    if (!Array.isArray(sources)) throw new TypeError('context.sources must be an array.');
    if (!Array.isArray(paths)) throw new TypeError('context.paths must be an array.');
    if (modes.length > MAX_DIAGNOSTIC_MODES) {
      throw new RangeError(`context.modes cannot contain more than ${MAX_DIAGNOSTIC_MODES} entries.`);
    }
    if (sources.length > MAX_SOURCES) {
      throw new RangeError(`context.sources cannot contain more than ${MAX_SOURCES} entries.`);
    }
    if (paths.length > MAX_DIAGNOSTIC_PATHS) {
      throw new RangeError(`context.paths cannot contain more than ${MAX_DIAGNOSTIC_PATHS} entries.`);
    }

    const evidence = [];
    const preparedModes = modes.map((mode, index) => {
      const frequency = typeof mode === 'number' ? mode : mode?.frequency;
      requirePositiveNumber(frequency, `context.modes[${index}].frequency`);
      return { frequency, index };
    });
    if (preparedModes.length > 0) {
      const rankedModes = preparedModes.toSorted((left, right) => {
        if (context.frequency === undefined) return left.frequency - right.frequency;
        return Math.abs(left.frequency - context.frequency)
          - Math.abs(right.frequency - context.frequency)
          || left.frequency - right.frequency;
      });
      const candidate = rankedModes[0];
      const offset = context.frequency === undefined
        ? ''
        : ` (${Number(Math.abs(candidate.frequency - context.frequency).toFixed(2))} Hz away)`;
      evidence.push({ label: 'Nearby mode candidate', value: `${formatFrequency(candidate.frequency)}${offset}` });
    }

    const preparedSources = sources.map((source, index) => {
      requireObject(source, `context.sources[${index}]`);
      const phase = source.phase ?? (
        context.frequency === undefined || source.delayMs === undefined
          ? undefined
          : 2 * Math.PI * context.frequency * source.delayMs / 1000
            + (source.polarity === 'inverted' ? Math.PI : 0)
      );
      if (phase === undefined) return null;
      requireFiniteNumber(phase, `context.sources[${index}].phase`);
      return { id: source.id ?? `Source ${index + 1}`, phase };
    }).filter(Boolean);
    let phaseCandidate = null;
    for (let left = 0; left < preparedSources.length; left += 1) {
      for (let right = left + 1; right < preparedSources.length; right += 1) {
        const separation = normalizedPhaseDifference(
          preparedSources[left].phase,
          preparedSources[right].phase,
        );
        if (!phaseCandidate || separation > phaseCandidate.separation) {
          phaseCandidate = { left: preparedSources[left], right: preparedSources[right], separation };
        }
      }
    }
    if (phaseCandidate) {
      const degrees = phaseCandidate.separation * 180 / Math.PI;
      evidence.push({
        label: 'Source phase separation',
        value: `${phaseCandidate.left.id} / ${phaseCandidate.right.id}: ${degrees.toFixed(1)}°`,
      });
    }

    const preparedPaths = paths.map((path, index) => {
      requireObject(path, `context.paths[${index}]`);
      requireNonnegativeNumber(path.length, `context.paths[${index}].length`);
      if (path.bounces !== undefined && (!Number.isSafeInteger(path.bounces) || path.bounces < 0)) {
        throw new RangeError(`context.paths[${index}].bounces must be a nonnegative safe integer.`);
      }
      for (const key of ['attenuationDb', 'energy', 'amplitude']) {
        if (path[key] !== undefined) requireFiniteNumber(path[key], `context.paths[${index}].${key}`);
      }
      const strength = path.energy !== undefined
        ? path.energy
        : path.amplitude !== undefined
          ? path.amplitude * path.amplitude
          : path.attenuationDb !== undefined
            ? 10 ** (path.attenuationDb / 10)
            : 1 / Math.max(path.length, Number.EPSILON) ** 2;
      if (!Number.isFinite(strength) || strength < 0) {
        throw new RangeError(`context.paths[${index}] strength must be finite and nonnegative.`);
      }
      return { ...path, strength, index };
    });
    if (preparedPaths.length > 0) {
      const strongest = preparedPaths.toSorted((left, right) => (
        right.strength - left.strength
        || (left.bounces ?? 0) - (right.bounces ?? 0)
        || left.length - right.length
      ))[0];
      evidence.push({
        label: 'Strongest early path',
        value: `${strongest.length.toFixed(2)} m, ${strongest.bounces ?? 0} bounce${(strongest.bounces ?? 0) === 1 ? '' : 's'}`,
      });
    }

    return {
      label: 'Likely null',
      explanation: evidence.length === 0
        ? 'This predicted dip may have multiple contributing causes; the available evidence is not enough to identify a unique cause.'
        : 'This predicted dip likely has multiple contributing causes. These values rank plausible contributors but do not identify a unique cause.',
      evidence,
    };
  };

  return {
    combineBroadbandBands,
    firstVerticalMode,
    verticalTransfer,
    fieldMetadata,
    resampleMap,
    sampleListeningPoint,
    diagnoseListeningPoint,
  };
});
