# Acoustic Room Simulator Design

**Status:** Approved for implementation

**Date:** 2026-07-15

**Deliverable:** A single standalone `acoustic-room-simulator.html` file that runs directly from `file://` without a web server or network access.

## Purpose

Build an exploratory acoustic-design workbench for hobbyist audiophiles and acoustical engineers comparing room geometry and loudspeaker placement. The app should make low-frequency standing waves, multi-source interference, broadband coverage, and early reflection paths understandable without presenting its approximations as measured or construction-grade predictions.

The guiding design principle is:

> Would this choice make the app useful to a hobbyist audiophile or acoustical engineer exploring room design and speaker placement options?

## Goals

- Edit an irregular room as a connected set of 1 × 1 m floor-plan cells.
- Place, rotate, configure, and remove common loudspeaker and subwoofer types.
- Show coherent low-frequency standing waves and source interference.
- Estimate higher-frequency direct coverage and at least five specular reflection bounces.
- Explore a single frequency or inspect broadband behavior.
- Inspect the predicted response at a movable listening point.
- Save reusable room-shape presets and portable complete projects.
- Explain solver fidelity, limits, elapsed time, and active assumptions.
- Remain responsive during editing by calculating away from the UI thread.

## Non-goals for the first version

- Construction-grade prediction or agreement with an unmeasured real room.
- Spatially varying wall materials, furniture, doors, windows, or absorbing objects.
- Sloped, vaulted, or varying-height ceilings.
- Full three-dimensional finite-difference simulation.
- Phase-accurate high-frequency interference through 20 kHz.
- Calibrated absolute SPL without source sensitivity and drive-voltage data.
- Importing CAD, DXF, or architectural floor-plan formats.
- Network storage, user accounts, or collaboration.

## Physical-model boundaries

### Hybrid calculation

The simulator uses two complementary models:

1. A two-dimensional finite-difference time-domain wave solver for coherent low-frequency behavior. This produces standing waves, modal peaks and nulls, and multi-source phase interference.
2. A geometric ray model for directivity, distance loss, and early reflections above the reliable wave-solver band. This traces at least five specular bounces.

The wave solver and ray model must be labeled separately when the distinction matters. The app must not describe ray-derived high-frequency coverage as phase-accurate interference.

### Wave-grid fidelity

- The displayed heatmap resolution and internal wave-grid spacing are independent.
- Display resolution is selectable from 0.1, 0.25, 0.5, and 1 m.
- Solver quality presets expose their internal cell size, cell count, stability margin, and conservative reliable-frequency limit.
- Standard quality targets approximately 0.075 m cells for a default 10 × 7 m room.
- The reliable wave limit is calculated from the actual cell size and a conservative points-per-wavelength rule rather than hard-coded.
- The focused 20–200 Hz range is guaranteed at supported room sizes. An advanced control may extend the frequency slider to the current solver's declared reliable limit, expected to be roughly 400–500 Hz for the default room at Standard quality.
- If a room and quality combination exceeds the computational budget, the app must explain the tradeoff and offer lower quality or a smaller room. It must not silently coarsen the solver grid.

### Height and vertical modes

- The room has one uniform ceiling height, defaulting to 2.5 m and adjustable from 2 to 10 m in 0.5 m increments.
- The heatmap is evaluated at a default seated-ear height of 1.2 m.
- Directional speakers use a default acoustic-center height of 1.1 m; subwoofers use 0.3 m.
- Source and listening heights are adjustable in 0.1 m increments and must remain between floor level and the current ceiling height.
- Floor-to-ceiling modal behavior is approximated analytically for a uniform-height extruded room and combined with the horizontal two-dimensional result.
- The methodology panel must identify this as an approximation rather than full 3D simulation.

### Boundaries and loss

- The room has a global wall absorption coefficient, default `α = 0.15`.
- Reflection amplitude uses `r = sqrt(1 - α)`, so the setting is physically named and energy-consistent rather than described only as a percentage loss per bounce.
- The first version uses one frequency-independent boundary coefficient. Spatially and frequency-varying absorption is reserved for future absorbing items and wall materials.
- Distance spreading and a modest frequency-dependent air-loss approximation apply to the ray model.

### Broadband aggregation

Pressure at unrelated frequencies cannot be summed coherently. The default **Broadband coverage** view therefore aggregates energy over logarithmically spaced bands:

- Wave-derived energy covers the coherent solver band.
- Ray-derived energy covers the source's remaining bandwidth through its upper band limit.
- The overlap is cross-faded rather than counted twice.
- Bands receive equal logarithmic weighting before source-response weighting, preventing the large number of high-frequency Hertz from dominating the result.
- The legend describes the result as relative broadband energy variation, not signed pressure or calibrated SPL.

### Coherent frequency view

- The normal frequency slider spans 20–200 Hz.
- Advanced mode can extend it to the current reliable wave limit.
- All active sources are treated as reproducing the same steady sinusoid at the selected frequency.
- Source gain, polarity, and delay alter complex amplitude and phase before sources are combined.
- The view reports relative pressure level and phase. It may optionally show positive and negative instantaneous pressure as contours, but the persistent quantitative scale is relative dB.

## Source library

Users drag sources from the persistent left library onto valid room cells. Directional sources show their axis and nominal dispersion cone when selected.

| Source | Nominal band | Directivity | Category |
| --- | --- | --- | --- |
| Full-range speaker | 20 Hz–20 kHz | Nominal 90° cone | Speaker |
| Bookshelf speaker | 50 Hz–20 kHz | Nominal 90° cone | Speaker |
| Subwoofer | 20–120 Hz | Omnidirectional | Subwoofer |
| High-passed bookshelf speaker | 40–120 Hz, −12 dB/octave below 80 Hz | Nominal 90° cone | Speaker |
| Low-passed subwoofer | 20–200 Hz, −12 dB/octave above 80 Hz | Omnidirectional | Subwoofer |

The directional model uses a smooth nominal 90° pattern instead of a discontinuous hard cutoff: on-axis output is 0 dB, the nominal ±45° edges are approximately −6 dB, and rear output is strongly attenuated. The methodology panel exposes the exact function used.

### Source limits and controls

- A project supports at most 10 sources in the Speaker category and 4 in the Subwoofer category.
- Dragging a library item into the room creates it at the drop position.
- Dragging a placed source outside the room removes it after a short, undoable confirmation state.
- Left and right arrow keys rotate the selected directional source in 45° increments.
- Omnidirectional sources do not expose rotation.
- Each selected source exposes:
  - Gain from −12 to +6 dB.
  - Normal or inverted polarity.
  - Delay from 0 to 20 ms.
  - Position and height.
  - Rotation for directional sources.
- Default sources are in phase, use 0 dB gain, and have 0 ms delay.
- Source controls use declared response curves rather than emitting equal energy outside their nominal band.

## Room editor

### Default room and workspace

- The initial room is a 10 × 7 m rectangle over a visible 1 × 1 m blueprint grid.
- The canvas supports pan and zoom when the floor plan exceeds the visible area.
- The editable grid expands as cells are added, up to a 30 × 30 m bounding box. Large rooms remain editable even when their chosen solver quality exceeds the computational budget; only refined analysis is gated.
- Room area, ceiling height, and derived volume remain visible in the room inspector.

### Room edit mode

- A **Room edit mode** checkbox appears beneath the source library.
- Enabling it pauses expensive analysis and changes floor-plan input from source manipulation to cell editing.
- Clicking a filled cell removes it.
- Clicking an empty cell adjacent by an edge to the room adds it.
- Click-drag paints a single add or remove operation based on the first cell touched.
- A complete pointer stroke is one undoable action.
- Undo and redo controls appear while room edit mode is active.
- `Escape` exits room edit mode.
- Edits that disconnect the room or create an enclosed hole are rejected with a specific inline explanation.
- Sources outside the revised boundary remain visible and flagged until repositioned or removed; they are never silently moved or deleted.
- Full analysis resumes after edit mode closes and invalid source positions are resolved.

## Workspace layout and visual direction

### Layout

The approved layout is a dense engineering workbench:

- Top bar: project name, calculation state, elapsed time, and reliable-frequency limit.
- Left rail: draggable source library, room edit mode, and analysis-view choices.
- Center: blueprint room canvas, heatmap, sources, listening point, and optional reflection paths.
- Right rail: context-sensitive room, source, or listening-point inspector.
- Bottom analysis strip: frequency control and the listening-point response curve.

The layout prioritizes persistent cause-and-effect visibility over maximizing canvas size.

### Visual system

- **Blueprint deep:** `#07111F` for the canvas surround.
- **Panel navy:** `#0D1829` for tool and inspector surfaces.
- **Grid blue:** `#1B3652` for the 1 m construction grid.
- **Drawing white:** `#E2E8F0` for walls and primary labels.
- **Wave cyan:** `#38BDF8` for selection, focus, and response curves.
- **Pressure amber:** `#FB923C` for energetic peaks and source axes.

Typography uses locally available system faces only: a condensed technical system stack for headings where available, the standard system UI stack for controls, and `ui-monospace` for measurements. No font or library downloads are allowed.

The signature visual is a live acoustic contour field laid over a restrained blueprint grid, anchored by a measurement-style listening-point crosshair. Motion is limited to calculation progress and intentional transitions and is disabled under `prefers-reduced-motion`.

Heatmap palettes must remain understandable for common color-vision deficiencies:

- Broadband energy uses a perceptually ordered sequential scale.
- Coherent relative level uses a labeled diverging scale with contour lines.
- Information is never encoded by color alone; legends, contours, and numeric listening-point readings remain available.

## Analysis workflow

The left rail offers three explicitly different questions:

1. **Broadband coverage** — relative energy variation from 20 Hz through each source's supported upper frequency.
2. **Coherent frequency** — pressure level and phase at one selected frequency within the reliable wave band.
3. **Reflection paths** — direct sound and at least five specular bounces, with path length, delay, and cumulative attenuation.

### Listening point

The UI calls the movable sampling crosshair **Listening point**. Internal code may use `probe`, and the tooltip may say “measurement probe.”

- Clicking an unoccupied valid location places or moves the listening point.
- Dragging moves it continuously within the room.
- It does not alter the acoustic simulation.
- Its inspector displays position, selected-frequency relative level and phase, and nearby predicted peaks and nulls.
- The bottom strip shows its response from 20 Hz to the current reliable wave limit with selectable smoothing.
- Diagnostic copy may identify a likely contributing mode, source-phase relationship, or early reflection. Such explanations must say “likely” and expose supporting values instead of claiming a unique cause.

## State and persistence

The application uses one authoritative state object. Renderers and workers receive immutable snapshots or versioned messages; they do not mutate UI state directly.

Persistent project data includes:

- Schema version.
- Room cells and grid origin.
- Ceiling height, wall absorption, and speed of sound.
- Source types and per-source controls.
- Listening-point position.
- Solver quality and display-map resolution.
- Active analysis settings.

Derived solver fields, heatmaps, path traces, undo history, selections, and transient UI messages are not persisted.

The advanced acoustic settings expose speed of sound directly, defaulting to 343 m/s with a valid range of 300–360 m/s. The first version does not infer it from temperature and humidity.

### Presets and projects

- A room-shape preset stores room cells, ceiling height, and wall absorption.
- A complete project stores all persistent project data.
- Both use browser-local storage for convenience.
- JSON export/import is the reliable portable mechanism because `localStorage` behavior for `file://` documents varies by browser.
- Exported JSON is schema-versioned and human-readable.
- Import validates type, range, source counts, connected geometry, and supported schema before replacing current state.
- A failed import leaves the current project unchanged and identifies the invalid field or constraint.

## Standalone technical architecture

- All HTML, CSS, JavaScript, worker source, icons, and default data are inline in `acoustic-room-simulator.html`.
- The page performs no network requests and uses no CDN or external runtime dependency.
- Canvas 2D renders the plan and field data. DOM controls remain real accessible elements rather than canvas-painted controls.
- The wave solver runs in a Web Worker created from an inline source Blob.
- If a browser restricts workers for a `file://` document, a chunked main-thread solver fallback yields between work slices so controls remain usable.
- Every calculation message includes a monotonically increasing state version. Results with an obsolete version are discarded.
- Room edits and source drags debounce refined calculation while allowing a quick approximate visual preview.
- Calculations lasting more than 500 ms show phase/progress information and a cancel control.

## Error and edge-case behavior

- An empty room shows instructions to add cells; analysis controls remain disabled.
- A project with no sources shows the room without a heatmap and directs the user to drag in a source.
- Invalid or outside sources are visibly flagged and excluded from calculation.
- Source-limit violations explain the applicable speaker or subwoofer limit.
- Unsupported or malformed imports never partially modify the project.
- Worker failure automatically attempts the chunked fallback and reports the change.
- Non-finite solver values stop the calculation, preserve the prior valid visualization, and surface solver settings useful for diagnosis.
- The methodology panel labels results as approximate and reports all inputs needed to understand the fidelity boundary.

## Accessibility and input

- All controls are keyboard reachable with visible focus.
- Arrow-key rotation applies only when a directional source has focus or is selected and focus is not inside an input control.
- Drag operations have keyboard alternatives for adding, positioning, and deleting sources.
- Canvas objects have a synchronized DOM list for assistive technology and precise keyboard selection.
- Status changes use a polite live region; errors use an assertive live region only when immediate intervention is required.
- The layout remains operable on a tablet-sized viewport, though desktop is the primary analysis environment.

## Validation strategy

### Deterministic automated tests

- Connected-room and hole detection.
- Cell toggle strokes and undo/redo boundaries.
- Source category limits and rotation increments.
- Source response, gain, polarity, delay, and directional weighting.
- JSON round-trip, schema validation, and rejected malformed imports.
- Courant stability, time-step selection, and reliable-frequency calculation.
- Inverse-distance and reflection-amplitude calculations.
- Cancellation and stale-result rejection.

### Numerical sanity checks

For rectangular rooms, compare predicted resonances with the analytical modal frequencies:

```text
f(nx, ny, nz) = c / 2 × sqrt((nx / Lx)² + (ny / Ly)² + (nz / Lz)²)
```

The built-in validation report lists expected and observed modes, absolute and percentage errors, solver spacing, stability margin, and reliable bandwidth. For rectangular-room validation below 200 Hz, each first-order axial mode must fall within the greater of one transform-frequency bin or 5% of its analytical frequency. This tolerance is fixed before observing test output.

### Browser verification

- Direct `file://` launch with zero network requests.
- Drag/drop creation, off-room removal, and keyboard alternatives.
- Room edit mode, stroke-based undo/redo, and topology rejection.
- 45° directional-source rotation.
- Worker execution, cancellation, and main-thread fallback.
- Browser-local presets plus JSON import/export.
- Responsive behavior, keyboard focus, reduced motion, and non-color heatmap cues.

### Performance targets

For the default 10 × 7 × 2.5 m room on a typical modern laptop:

- Approximate drag/edit preview appears within 100 ms.
- Standard-quality refined calculation finishes within 5 seconds.
- Cancellation is acknowledged within 100 ms.
- Work lasting longer than 500 ms displays visible progress.

If a target is missed, the app reports the observed elapsed time and offers an explicit quality tradeoff; it does not mislabel an incomplete calculation as current.

## Methodology and validation panel

A collapsed panel exposes:

- Calculation method used for each visible layer.
- Display resolution and internal wave-grid spacing.
- Cell count, time step, stability margin, and points per wavelength.
- Reliable coherent-frequency range.
- Wall absorption, speed of sound, ceiling and sampling heights.
- Active sources and their response curves.
- Reflection depth and loss model.
- Solver elapsed time and any fallback in use.
- Rectangular-room numerical sanity results when applicable.
- Plain-language limitations and the distinction between prediction and measurement.

## Acceptance criteria

The first version is accepted when:

1. The single HTML file opens directly from disk and performs no network access.
2. The default 10 × 7 × 2.5 m room appears on a 1 m blueprint grid.
3. Room edit mode supports add/remove toggling, stroke undo/redo, and connected hole-free geometry.
4. All five source types can be dragged in, configured, rotated where applicable, and removed by dragging out.
5. The 10-speaker and 4-subwoofer limits are enforced by category.
6. Broadband coverage, coherent frequency, and five-bounce reflection views are distinct and labeled accurately.
7. The 20–200 Hz coherent view visibly produces standing-wave peaks and nulls in a rectangular room.
8. Gain, polarity, and delay visibly alter coherent multi-source interference.
9. Ceiling height is adjustable in 0.5 m increments and influences the reported vertical-mode response.
10. The listening point displays local response and phase without affecting the field.
11. Room presets persist locally, and complete projects export/import as validated JSON.
12. The app reports solver fidelity and limitations, passes the defined numerical sanity checks, and meets or clearly reports the performance targets.
