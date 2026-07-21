# Acoustic Room Simulator

A standalone, blueprint-style room-acoustics workbench for exploring room
geometry, loudspeaker placement, low-frequency standing waves, broadband
coverage, and early reflections.

The finished application will be a single `acoustic-room-simulator.html` file
that opens directly from `file://`. It has no server, CDN, external font,
runtime package, account, or network requirement.

## Project Status

The acoustic core is implemented and reviewed through Task 9:

- topology-safe irregular room geometry;
- bounded project state and undo/redo;
- five source models with response, directivity, gain, delay, and polarity;
- versioned local persistence and portable JSON;
- modal math and solver-quality policy;
- coherent low-frequency wave simulation;
- noncoherent five-bounce ray tracing; and
- energy aggregation, vertical-mode transfer, resampling, and listening-point
  diagnostics.

Tasks 10 through 14 remain: worker orchestration, rendering, workbench UI,
integrated workflow, and final browser/performance verification. The checked-in
HTML file is therefore not yet the finished application.

See [`docs/HANDOFF.md`](docs/HANDOFF.md) for the exact continuation point.

## Requirements

- Node.js 20 or newer for development and tests
- A modern browser for the final standalone application

There are no package dependencies to install.

## Development

```bash
npm test
npm run build
open acoustic-room-simulator.html
```

`npm run build` concatenates the local CSS and JavaScript modules into the one
offline HTML artifact. During implementation, work directly on `main` and
follow [`AGENTS.md`](AGENTS.md).

## Model Boundaries

This is an exploratory design tool, not a substitute for measurement or a
construction-grade boundary-element model.

- Low frequencies use a phase-coherent two-dimensional wave solver.
- Ceiling-height effects use an analytical uniform-height approximation.
- Higher frequencies use noncoherent geometric ray energy with five bounces.
- Broadband maps combine logarithmic-band energy rather than unrelated pressure
  or decibel values.
- Absolute calibrated SPL is outside the first version because source
  sensitivity and drive voltage are not modeled.

The application must expose its active solver limits and must not describe a
predicted null or reflection as a uniquely identified real-room cause.

## Documentation

- [Repository instructions](AGENTS.md)
- [Current handoff and task status](docs/HANDOFF.md)
- [Approved design specification](docs/superpowers/specs/2026-07-15-acoustic-room-simulator-design.md)
- [Implementation plan](docs/superpowers/plans/2026-07-15-acoustic-room-simulator.md)
