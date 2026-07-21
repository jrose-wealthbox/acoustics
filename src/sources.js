(function (root, factory) {
  const api = factory();
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function () {
  const freezeDefinition = definition => Object.freeze({
    ...definition,
    crossover: definition.crossover ? Object.freeze({ ...definition.crossover }) : null,
  });

  const SOURCE_TYPES = Object.freeze({
    'full-range': freezeDefinition({
      id: 'full-range',
      label: 'Full-range speaker',
      minHz: 20,
      maxHz: 20000,
      directivity: 'directional',
      category: 'speaker',
      crossover: null,
    }),
    bookshelf: freezeDefinition({
      id: 'bookshelf',
      label: 'Bookshelf speaker',
      minHz: 50,
      maxHz: 20000,
      directivity: 'directional',
      category: 'speaker',
      crossover: null,
    }),
    subwoofer: freezeDefinition({
      id: 'subwoofer',
      label: 'Subwoofer',
      minHz: 20,
      maxHz: 120,
      directivity: 'omni',
      category: 'subwoofer',
      crossover: null,
    }),
    'hp-bookshelf': freezeDefinition({
      id: 'hp-bookshelf',
      label: 'High-passed bookshelf',
      minHz: 40,
      maxHz: 120,
      directivity: 'directional',
      category: 'speaker',
      crossover: { kind: 'high-pass', frequency: 80, slopeDbPerOctave: 12 },
    }),
    'lp-subwoofer': freezeDefinition({
      id: 'lp-subwoofer',
      label: 'Low-passed subwoofer',
      minHz: 20,
      maxHz: 200,
      directivity: 'omni',
      category: 'subwoofer',
      crossover: { kind: 'low-pass', frequency: 80, slopeDbPerOctave: 12 },
    }),
  });

  const sourceDefinition = type => (
    typeof type === 'string' && Object.hasOwn(SOURCE_TYPES, type)
      ? SOURCE_TYPES[type]
      : null
  );

  const sourceResponseDb = (type, frequency) => {
    const definition = sourceDefinition(type);
    if (
      !definition
      || typeof frequency !== 'number'
      || !Number.isFinite(frequency)
      || frequency < definition.minHz
      || frequency > definition.maxHz
    ) return -Infinity;
    if (!definition.crossover) return 0;

    const octave = Math.log2(frequency / definition.crossover.frequency);
    if (definition.crossover.kind === 'high-pass' && octave < 0) {
      return definition.crossover.slopeDbPerOctave * octave;
    }
    if (definition.crossover.kind === 'low-pass' && octave > 0) {
      return -definition.crossover.slopeDbPerOctave * octave;
    }
    return 0;
  };

  const DIRECTIONAL_CONTROL_POINTS = Object.freeze([
    Object.freeze([0, 0]),
    Object.freeze([Math.PI / 4, -6]),
    Object.freeze([Math.PI / 2, -24]),
    Object.freeze([Math.PI, -30]),
  ]);

  const directionalGain = (type, angleRadians) => {
    const definition = sourceDefinition(type);
    if (!definition || typeof angleRadians !== 'number' || !Number.isFinite(angleRadians)) return 0;
    if (definition.directivity === 'omni') return 1;

    // atan2 folds any signed/wrapped bearing into its shortest off-axis angle.
    const angle = Math.abs(Math.atan2(Math.sin(angleRadians), Math.cos(angleRadians)));
    for (let index = 1; index < DIRECTIONAL_CONTROL_POINTS.length; index += 1) {
      const [rightAngle, rightDb] = DIRECTIONAL_CONTROL_POINTS[index];
      if (angle > rightAngle) continue;
      const [leftAngle, leftDb] = DIRECTIONAL_CONTROL_POINTS[index - 1];
      const ratio = (angle - leftAngle) / (rightAngle - leftAngle);
      return 10 ** ((leftDb + ratio * (rightDb - leftDb)) / 20);
    }
    return 10 ** (-30 / 20);
  };

  /**
   * Returns source gain in Cartesian complex form: `{ real, imaginary }`.
   * Phasors use e^(-iwt) time dependence, so a delay of t seconds contributes
   * the positive phase +2πft used here. Downstream solvers must preserve this sign.
   */
  const sourceComplexGain = (source, frequency) => {
    const responseDb = sourceResponseDb(source?.type, frequency);
    if (responseDb === -Infinity) return { real: 0, imaginary: 0 };

    const amplitude = 10 ** ((responseDb + source.gainDb) / 20);
    const phase = 2 * Math.PI * frequency * (source.delayMs / 1000)
      + (source.polarity === 'inverted' ? Math.PI : 0);
    return {
      real: amplitude * Math.cos(phase),
      imaginary: amplitude * Math.sin(phase),
    };
  };

  const sourceCategory = type => sourceDefinition(type)?.category || null;

  const CATEGORY_LIMITS = Object.freeze({ speaker: 10, subwoofer: 4 });
  const canAddSource = (sources, type) => {
    const category = sourceCategory(type);
    if (!category) return { ok: false, error: 'Unknown source type.' };
    if (!Array.isArray(sources)) return { ok: false, error: 'Sources must be an array.' };

    const count = sources.reduce((total, source) => (
      sourceCategory(source?.type) === category ? total + 1 : total
    ), 0);
    if (count >= CATEGORY_LIMITS[category]) {
      const label = category === 'speaker' ? 'speaker' : 'subwoofer';
      return {
        ok: false,
        error: `A project supports at most ${CATEGORY_LIMITS[category]} ${label} sources.`,
      };
    }
    return { ok: true, error: null };
  };

  return {
    SOURCE_TYPES,
    sourceResponseDb,
    directionalGain,
    sourceComplexGain,
    sourceCategory,
    canAddSource,
  };
});
