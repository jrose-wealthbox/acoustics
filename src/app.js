(function (root, factory) {
  const dependencies = (
    typeof module !== 'undefined' && module.exports
      ? {
        ...require('./namespace.js'),
        ...require('./geometry.js'),
        ...require('./sources.js'),
        ...require('./state.js'),
        ...require('./renderer.js'),
        ...require('./controller.js'),
        ...require('./persistence.js'),
      }
      : (root.RoomWave || {})
  );
  const api = factory(dependencies);
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function (RoomWave) {
  const INPUT_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
  const MAX_STROKE_CELLS = 900;
  const SOURCE_MOVE_STEP = 0.25;
  const MIN_ZOOM = 0.25;
  const MAX_UI_ZOOM = 8;
  const MAX_UI_PAN = 1_000_000;
  const REQUIRED_ELEMENTS = [
    'app',
    'project-name',
    'calculation-status',
    'elapsed-time',
    'reliable-limit',
    'source-library',
    'room-edit-mode',
    'undo-button',
    'redo-button',
    'analysis-controls',
    'room-canvas',
    'object-list',
    'inspector-title',
    'inspector-content',
    'frequency-control',
    'frequency-value',
    'response-chart',
    'preset-dialog',
    'project-dialog',
    'methodology',
    'polite-status',
    'error-status',
    'remove-notice',
    'remove-undo',
    'cancel-calculation',
  ];
  const REQUIRED_DEPENDENCIES = [
    'createDefaultProject',
    'createHistory',
    'dispatchHistory',
    'undo',
    'redo',
    'buildRenderPlan',
    'renderRoom',
    'hitTest',
  ];

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
  const clonePoint = (point, name) => {
    requireObject(point, name);
    requireFiniteNumber(point.x, `${name}.x`);
    requireFiniteNumber(point.y, `${name}.y`);
    return { x: point.x, y: point.y };
  };

  const interactionToAction = (event, context = {}) => {
    requireObject(event, 'event');
    requireObject(context, 'context');
    if (event.type === 'pointerstroke') {
      if (!context.roomEditMode) return null;
      if (!Array.isArray(event.cells)) {
        throw new TypeError('event.cells must be an array.');
      }
      if (event.cells.length > MAX_STROKE_CELLS) {
        throw new RangeError(`event.cells cannot contain more than ${MAX_STROKE_CELLS} cells.`);
      }
      const points = event.cells.map((point, index) => {
        const copy = clonePoint(point, `event.cells[${index}]`);
        if (!Number.isSafeInteger(copy.x) || !Number.isSafeInteger(copy.y)) {
          throw new RangeError(`event.cells[${index}] must use safe integer coordinates.`);
        }
        return copy;
      });
      return points.length ? { type: 'room/stroke', points } : null;
    }
    if (event.type === 'sourcedrop') {
      if (typeof event.id !== 'string' || event.id.length === 0) {
        throw new TypeError('event.id must be a nonempty string.');
      }
      const point = clonePoint(event.point, 'event.point');
      return event.inside
        ? { type: 'source/move', id: event.id, x: point.x, y: point.y }
        : { type: 'source/remove', id: event.id };
    }
    if (event.type === 'listeningdrop') {
      if (!event.inside) return null;
      const point = clonePoint(event.point, 'event.point');
      return { type: 'listening/move', x: point.x, y: point.y };
    }
    const targetTag = typeof event.targetTag === 'string'
      ? event.targetTag.toUpperCase()
      : '';
    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      && context.selectedSource
      && !context.roomEditMode
      && !INPUT_TAGS.has(targetTag)
      && !event.targetEditable
      && RoomWave.SOURCE_TYPES?.[context.selectedSource.type]?.directivity === 'directional'
    ) {
      return {
        type: 'source/rotate',
        id: context.selectedSource.id,
        delta: event.key === 'ArrowRight' ? 45 : -45,
      };
    }
    if (event.key === 'Escape' && context.roomEditMode) {
      return { type: 'ui/room-edit', value: false };
    }
    return null;
  };

  const createApp = (document, suppliedDependencies = RoomWave) => {
    requireObject(document, 'document');
    if (typeof document.getElementById !== 'function' || typeof document.createElement !== 'function') {
      throw new TypeError('document must provide DOM element lookup and creation.');
    }
    requireObject(suppliedDependencies, 'dependencies');
    for (const name of REQUIRED_DEPENDENCIES) {
      if (typeof suppliedDependencies[name] !== 'function') {
        throw new TypeError(`dependencies.${name} must be a function.`);
      }
    }
    requireObject(suppliedDependencies.SOURCE_TYPES, 'dependencies.SOURCE_TYPES');

    const elements = Object.fromEntries(REQUIRED_ELEMENTS.map(id => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`Required workbench element #${id} is missing.`);
      return [id, element];
    }));
    const canvas = elements['room-canvas'];
    const context = canvas.getContext?.('2d');
    if (!context) throw new Error('The room canvas requires a Canvas 2D context.');
    const view = document.defaultView || globalThis;
    const timerSet = typeof view.setTimeout === 'function' ? view.setTimeout.bind(view) : setTimeout;
    const timerClear = typeof view.clearTimeout === 'function' ? view.clearTimeout.bind(view) : clearTimeout;

    const initialProject = suppliedDependencies.initialProject
      ? structuredClone(suppliedDependencies.initialProject)
      : suppliedDependencies.createDefaultProject();
    let history = suppliedDependencies.createHistory(initialProject);
    let activePlan = null;
    let result = null;
    let drag = null;
    let selection = initialProject.ui.selectedSourceId ? 'source' : 'room';
    let projectName = 'Untitled room';
    let sourceSequence = 1;
    let removalTimer = null;
    let removalUndoAvailable = false;
    let destroyed = false;
    const cleanup = [];

    const listen = (target, type, listener, options) => {
      target.addEventListener(type, listener, options);
      cleanup.push(() => target.removeEventListener(type, listener, options));
    };
    const dataTarget = (target, key) => {
      if (target?.dataset?.[key] !== undefined) return target;
      if (typeof target?.closest !== 'function') return null;
      const attribute = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      return target.closest(`[data-${attribute}]`);
    };
    const current = () => history.present;
    const sourceById = id => current().sources.find(source => source.id === id) || null;
    const selectedSource = () => sourceById(current().ui.selectedSourceId);
    const cellKeyForPoint = point => `${Math.floor(point.x)},${Math.floor(point.y)}`;
    const pointInsideRoom = point => current().room.cells.has(cellKeyForPoint(point));
    const invalidSources = project => project.sources.filter(source => (
      !project.room.cells.has(cellKeyForPoint(source))
    ));
    const topologyValid = project => {
      if (project.room.cells.size === 0) return false;
      if (typeof suppliedDependencies.analyzeTopology !== 'function') return true;
      const topology = suppliedDependencies.analyzeTopology(project.room.cells);
      return topology.connected && !topology.hasHole;
    };
    const viewModel = () => {
      const project = current();
      const outside = invalidSources(project);
      let analysisReason = null;
      if (project.room.cells.size === 0) analysisReason = 'Add room cells before analysis.';
      else if (!topologyValid(project)) analysisReason = 'Resolve room topology before analysis.';
      else if (project.ui.roomEditMode) analysisReason = 'Analysis is paused during room edit mode.';
      else if (outside.length) analysisReason = 'Move or remove sources outside the room before analysis.';
      else if (project.sources.length === 0) analysisReason = 'Add a source to begin analysis.';
      return {
        project,
        selectedSource: selectedSource(),
        invalidSources: outside,
        analysisDisabled: analysisReason !== null,
        analysisReason,
        roomArea: project.room.cells.size,
        roomVolume: project.room.cells.size * project.room.ceilingHeight,
      };
    };

    const setPoliteStatus = message => {
      elements['polite-status'].textContent = message || '';
    };
    const setError = message => {
      elements['error-status'].textContent = message || '';
      elements['error-status'].hidden = !message;
    };
    const setUi = changes => {
      const project = current();
      history = {
        ...history,
        present: { ...project, ui: { ...project.ui, ...changes } },
      };
    };

    const element = (tagName, options = {}) => {
      const node = document.createElement(tagName);
      if (options.text !== undefined) node.textContent = options.text;
      if (options.className) node.className = options.className;
      if (options.type) node.type = options.type;
      if (options.value !== undefined) node.value = String(options.value);
      if (options.title) node.title = options.title;
      if (options.dataset) Object.assign(node.dataset, options.dataset);
      if (options.attributes) {
        for (const [name, value] of Object.entries(options.attributes)) {
          node.setAttribute(name, value);
        }
      }
      return node;
    };
    const button = (text, action, extraDataset = {}, attributes = {}) => element('button', {
      text,
      type: 'button',
      dataset: { action, ...extraDataset },
      attributes,
    });
    const labelWithInput = (labelText, control, value, attributes = {}) => {
      const { tagName = 'input', ...inputAttributes } = attributes;
      const label = element('label', { className: 'field-control' });
      const span = element('span', { text: labelText });
      const input = element(tagName, {
        value,
        dataset: { control },
        attributes: inputAttributes,
      });
      label.append(span, input);
      return label;
    };

    const renderObjectList = project => {
      const activeControl = elements['object-list'].contains?.(document.activeElement)
        ? document.activeElement
        : null;
      const focusKey = activeControl ? {
        action: activeControl.dataset.action,
        id: activeControl.dataset.id,
        dx: activeControl.dataset.dx,
        dy: activeControl.dataset.dy,
      } : null;
      const items = [];
      const listenerItem = element('li');
      listenerItem.append(
        button(
          `Listening point · ${project.listeningPoint.x.toFixed(2)}, ${project.listeningPoint.y.toFixed(2)} m`,
          'select-listening',
        ),
        button('←', 'move-listening', { dx: -SOURCE_MOVE_STEP, dy: 0 }, { 'aria-label': 'Move Listening point left' }),
        button('→', 'move-listening', { dx: SOURCE_MOVE_STEP, dy: 0 }, { 'aria-label': 'Move Listening point right' }),
        button('↑', 'move-listening', { dx: 0, dy: -SOURCE_MOVE_STEP }, { 'aria-label': 'Move Listening point up' }),
        button('↓', 'move-listening', { dx: 0, dy: SOURCE_MOVE_STEP }, { 'aria-label': 'Move Listening point down' }),
      );
      items.push(listenerItem);
      for (const source of project.sources) {
        const definition = suppliedDependencies.SOURCE_TYPES[source.type];
        const item = element('li');
        const outside = !project.room.cells.has(cellKeyForPoint(source));
        if (outside) item.className = 'object-warning';
        item.append(
          button(
            `${definition.label} · ${source.x.toFixed(2)}, ${source.y.toFixed(2)} m${outside ? ' · outside room' : ''}`,
            'select-source',
            { id: source.id },
          ),
          button('←', 'move-source', { id: source.id, dx: -SOURCE_MOVE_STEP, dy: 0 }, { 'aria-label': `Move ${definition.label} left` }),
          button('→', 'move-source', { id: source.id, dx: SOURCE_MOVE_STEP, dy: 0 }, { 'aria-label': `Move ${definition.label} right` }),
          button('↑', 'move-source', { id: source.id, dx: 0, dy: -SOURCE_MOVE_STEP }, { 'aria-label': `Move ${definition.label} up` }),
          button('↓', 'move-source', { id: source.id, dx: 0, dy: SOURCE_MOVE_STEP }, { 'aria-label': `Move ${definition.label} down` }),
          button('Delete', 'remove-source', { id: source.id }, { 'aria-label': `Delete ${definition.label}` }),
        );
        items.push(item);
      }
      if (project.ui.roomEditMode) {
        for (const item of items) {
          for (const control of item.querySelectorAll('button')) control.disabled = true;
        }
      }
      elements['object-list'].replaceChildren(...items);
      if (focusKey) {
        const controls = elements['object-list'].querySelectorAll('button');
        for (const control of controls) {
          if (
            control.dataset.action === focusKey.action
            && control.dataset.id === focusKey.id
            && control.dataset.dx === focusKey.dx
            && control.dataset.dy === focusKey.dy
          ) {
            control.focus();
            break;
          }
        }
      }
    };

    const renderInspector = model => {
      const activeControl = elements['inspector-content'].contains?.(document.activeElement)
        ? document.activeElement
        : null;
      const focusKey = activeControl ? {
        control: activeControl.dataset.control,
        action: activeControl.dataset.action,
        id: activeControl.dataset.id,
      } : null;
      const project = model.project;
      const controls = [];
      if (selection === 'source' && model.selectedSource) {
        const source = model.selectedSource;
        const definition = suppliedDependencies.SOURCE_TYPES[source.type];
        elements['inspector-title'].textContent = definition.label;
        controls.push(
          labelWithInput('Gain (dB)', 'source-gain', source.gainDb, {
            type: 'number', min: '-12', max: '6', step: '0.5',
          }),
          labelWithInput('Delay (ms)', 'source-delay', source.delayMs, {
            type: 'number', min: '0', max: '20', step: '0.1',
          }),
          labelWithInput('Height (m)', 'source-height', source.z, {
            type: 'number', min: '0.1', max: String(project.room.ceilingHeight - 0.1), step: '0.1',
          }),
        );
        const polarity = labelWithInput('Polarity', 'source-polarity', source.polarity, {
          tagName: 'select',
        });
        const polaritySelect = polarity.children[1];
        polaritySelect.append(
          element('option', { text: 'Normal', value: 'normal' }),
          element('option', { text: 'Inverted', value: 'inverted' }),
        );
        polaritySelect.value = source.polarity;
        controls.push(polarity);
        if (definition.directivity === 'directional') {
          controls.push(labelWithInput('Rotation (°)', 'source-rotation', source.rotation, {
            type: 'number', step: '45',
          }));
        }
        controls.push(button('Remove source', 'remove-selected-source', { id: source.id }));
      } else if (selection === 'listening') {
        elements['inspector-title'].textContent = 'Listening point';
        controls.push(
          element('p', {
            text: `Position ${project.listeningPoint.x.toFixed(2)}, ${project.listeningPoint.y.toFixed(2)} m`,
          }),
          labelWithInput('Height (m)', 'listening-height', project.listeningPoint.z, {
            type: 'number', min: '0.1', max: String(project.room.ceilingHeight - 0.1), step: '0.1',
          }),
          element('p', {
            text: 'Predicted level, phase, and likely contributors appear after analysis.',
            className: 'muted',
          }),
        );
      } else {
        selection = 'room';
        elements['inspector-title'].textContent = 'Room';
        controls.push(
          element('p', { text: `${model.roomArea} m² · ${model.roomVolume.toFixed(1)} m³` }),
          labelWithInput('Ceiling height (m)', 'room-height', project.room.ceilingHeight, {
            type: 'number', min: '2', max: '10', step: '0.5',
          }),
          labelWithInput('Wall absorption α', 'room-absorption', project.room.absorption, {
            type: 'number', min: '0', max: '1', step: '0.01',
          }),
          labelWithInput('Speed of sound (m/s)', 'speed-of-sound', project.acoustics.speedOfSound, {
            type: 'number', min: '300', max: '360', step: '1',
          }),
        );
      }
      elements['inspector-content'].replaceChildren(...controls);
      if (focusKey) {
        const focusable = [
          ...elements['inspector-content'].querySelectorAll('input'),
          ...elements['inspector-content'].querySelectorAll('select'),
          ...elements['inspector-content'].querySelectorAll('button'),
        ];
        for (const control of focusable) {
          if (
            control.dataset.control === focusKey.control
            && control.dataset.action === focusKey.action
            && control.dataset.id === focusKey.id
          ) {
            control.focus();
            break;
          }
        }
      }
    };

    const displayProject = () => {
      const project = current();
      if (!drag?.preview) return project;
      if (drag.kind === 'source') {
        return {
          ...project,
          sources: project.sources.map(source => (
            source.id === drag.id ? { ...source, ...drag.preview } : source
          )),
        };
      }
      if (drag.kind === 'listening') {
        return { ...project, listeningPoint: { ...project.listeningPoint, ...drag.preview } };
      }
      return project;
    };

    const render = () => {
      if (destroyed) return;
      const model = viewModel();
      elements['project-name'].value = projectName;
      elements['room-edit-mode'].checked = model.project.ui.roomEditMode;
      elements['undo-button'].hidden = !model.project.ui.roomEditMode;
      elements['redo-button'].hidden = !model.project.ui.roomEditMode;
      elements['undo-button'].disabled = history.past.length === 0;
      elements['redo-button'].disabled = history.future.length === 0;
      elements['frequency-control'].value = String(model.project.analysis.frequency);
      elements['frequency-control'].disabled = model.analysisDisabled;
      elements['frequency-value'].textContent = `${model.project.analysis.frequency} Hz`;
      elements['analysis-controls'].setAttribute(
        'aria-disabled',
        model.analysisDisabled ? 'true' : 'false',
      );
      if (typeof elements['analysis-controls'].querySelectorAll === 'function') {
        for (const input of elements['analysis-controls'].querySelectorAll('input')) {
          input.disabled = model.analysisDisabled;
          input.checked = input.value === model.project.analysis.view;
        }
      }
      elements['calculation-status'].textContent = model.analysisReason || 'Ready for analysis';
      elements['elapsed-time'].textContent = 'Elapsed —';
      elements['reliable-limit'].textContent = 'Reliable range calculated with analysis';
      elements['cancel-calculation'].hidden = true;
      if (typeof elements['source-library'].querySelectorAll === 'function') {
        for (const sourceButton of elements['source-library'].querySelectorAll('button')) {
          sourceButton.disabled = model.project.ui.roomEditMode;
          sourceButton.draggable = !model.project.ui.roomEditMode;
        }
      }
      renderObjectList(model.project);
      renderInspector(model);

      const rect = canvas.getBoundingClientRect?.() || {};
      const width = rect.width || canvas.clientWidth || 800;
      const height = rect.height || canvas.clientHeight || 560;
      const dpr = Number.isFinite(view.devicePixelRatio) ? view.devicePixelRatio : 1;
      try {
        activePlan = suppliedDependencies.buildRenderPlan(
          displayProject(),
          result,
          { width, height, dpr },
        );
        suppliedDependencies.renderRoom(context, activePlan);
        setError(model.project.ui.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    };

    const dispatch = action => {
      requireObject(action, 'action');
      if (destroyed) throw new Error('App is destroyed.');
      if (action.type === 'ui/room-edit') {
        if (typeof action.value !== 'boolean') throw new TypeError('action.value must be boolean.');
        setUi({
          roomEditMode: action.value,
          selectedSourceId: action.value ? null : current().ui.selectedSourceId,
          message: null,
        });
        if (action.value) selection = 'room';
      } else if (action.type === 'ui/select-source') {
        const source = sourceById(action.id);
        if (!source) return current();
        setUi({ selectedSourceId: source.id });
        selection = 'source';
      } else if (action.type === 'ui/select-listening') {
        setUi({ selectedSourceId: null });
        selection = 'listening';
      } else if (action.type === 'ui/pan') {
        requireFiniteNumber(action.x, 'action.x');
        requireFiniteNumber(action.y, 'action.y');
        if (Math.abs(action.x) > MAX_UI_PAN || Math.abs(action.y) > MAX_UI_PAN) {
          throw new RangeError('action pan components must be within 1,000,000 CSS pixels.');
        }
        setUi({ pan: { x: action.x, y: action.y } });
      } else if (action.type === 'ui/zoom') {
        requireFiniteNumber(action.value, 'action.value');
        setUi({ zoom: Math.min(MAX_UI_ZOOM, Math.max(MIN_ZOOM, action.value)) });
      } else {
        hideRemovalNotice();
        history = suppliedDependencies.dispatchHistory(history, action);
        if (current().ui.selectedSourceId && !sourceById(current().ui.selectedSourceId)) {
          setUi({ selectedSourceId: null });
          selection = 'room';
        }
      }
      render();
      return current();
    };

    const undo = () => {
      if (destroyed) throw new Error('App is destroyed.');
      hideRemovalNotice();
      history = suppliedDependencies.undo(history);
      render();
      return current();
    };
    const redo = () => {
      if (destroyed) throw new Error('App is destroyed.');
      hideRemovalNotice();
      history = suppliedDependencies.redo(history);
      render();
      return current();
    };
    const nextSourceId = type => {
      let id;
      do {
        id = `${type}-${sourceSequence}`;
        sourceSequence += 1;
      } while (sourceById(id));
      return id;
    };
    const sortedCells = () => [...current().room.cells]
      .map(key => key.split(',').map(Number))
      .sort((left, right) => left[1] - right[1] || left[0] - right[0]);
    const placementForNewSource = () => {
      const occupied = new Set(current().sources.map(source => cellKeyForPoint(source)));
      const cells = sortedCells();
      const cell = cells.find(([x, y]) => !occupied.has(`${x},${y}`)) || cells[0];
      return cell ? { x: cell[0] + 0.5, y: cell[1] + 0.5 } : null;
    };
    const addSource = (type, point = placementForNewSource()) => {
      if (!suppliedDependencies.SOURCE_TYPES[type] || !point) return null;
      const source = { id: nextSourceId(type), type, x: point.x, y: point.y };
      dispatch({ type: 'source/add', source });
      if (sourceById(source.id)) dispatch({ type: 'ui/select-source', id: source.id });
      return sourceById(source.id);
    };
    const canvasPoint = event => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    };
    const worldPoint = screen => {
      if (!activePlan || !screen) return null;
      if (activePlan.transform) {
        const point = {
          x: activePlan.transform.minX
            + (screen.x - activePlan.transform.offsetX) / activePlan.transform.scale,
          y: activePlan.transform.minY
            + (screen.y - activePlan.transform.offsetY) / activePlan.transform.scale,
        };
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
      }
      const hit = suppliedDependencies.hitTest(activePlan, screen);
      return hit?.kind === 'cell' ? { x: hit.x + 0.5, y: hit.y + 0.5 } : null;
    };
    const worldCell = screen => {
      if (activePlan && !activePlan.transform && current().room.cells.size === 0 && screen) {
        const rect = canvas.getBoundingClientRect?.() || {};
        const width = rect.width || canvas.clientWidth || 800;
        const height = rect.height || canvas.clientHeight || 560;
        const scale = 40 * current().ui.zoom;
        const x = Math.floor((screen.x - width / 2 - current().ui.pan.x) / scale);
        const y = Math.floor((screen.y - height / 2 - current().ui.pan.y) / scale);
        return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : null;
      }
      const point = worldPoint(screen);
      if (!point) return null;
      const x = Math.floor(point.x);
      const y = Math.floor(point.y);
      return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : null;
    };
    const appendRoomCells = (roomDrag, cell) => {
      if (roomDrag.overflow) return;
      let x = roomDrag.lastCell.x;
      let y = roomDrag.lastCell.y;
      const dx = Math.abs(cell.x - x);
      const dy = Math.abs(cell.y - y);
      if (dx + dy > MAX_STROKE_CELLS - roomDrag.cells.length) {
        roomDrag.overflow = true;
        return;
      }
      const stepX = Math.sign(cell.x - x);
      const stepY = Math.sign(cell.y - y);
      let error = dx - dy;
      while (x !== cell.x || y !== cell.y) {
        const doubled = 2 * error;
        if (doubled > -dy) {
          error -= dy;
          x += stepX;
          const point = { x, y };
          const key = `${point.x},${point.y}`;
          if (!roomDrag.seen.has(key)) {
            roomDrag.seen.add(key);
            roomDrag.cells.push(point);
          }
        }
        if (doubled >= dx) continue;
        error += dx;
        y += stepY;
        const point = { x, y };
        const key = `${point.x},${point.y}`;
        if (!roomDrag.seen.has(key)) {
          roomDrag.seen.add(key);
          roomDrag.cells.push(point);
        }
      }
      roomDrag.lastCell = cell;
    };
    const hitAt = screen => (
      activePlan && screen ? suppliedDependencies.hitTest(activePlan, screen) : null
    );
    const releasePointer = pointerId => {
      try {
        canvas.releasePointerCapture(pointerId);
      } catch (_) {
        // Some browsers release capture before pointercancel reaches the element.
      }
    };
    const hideRemovalNotice = () => {
      if (removalTimer !== null) timerClear(removalTimer);
      removalTimer = null;
      removalUndoAvailable = false;
      elements['remove-notice'].hidden = true;
    };
    const showRemovalNotice = label => {
      hideRemovalNotice();
      removalUndoAvailable = true;
      elements['remove-notice'].hidden = false;
      elements['remove-notice'].textContent = `${label} removed. `;
      elements['remove-notice'].append(elements['remove-undo']);
      setPoliteStatus(`${label} removed. Undo is available.`);
      removalTimer = timerSet(() => {
        elements['remove-notice'].hidden = true;
        removalUndoAvailable = false;
        removalTimer = null;
      }, 5000);
    };
    const finishDrag = (event, cancelled = false) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const completed = drag;
      drag = null;
      releasePointer(event.pointerId);
      if (cancelled) {
        render();
        return;
      }
      if (completed.kind === 'room') {
        if (completed.overflow) {
          setUi({ message: `Room strokes are limited to ${MAX_STROKE_CELLS} cells; no cells were changed.` });
          render();
          return;
        }
        const action = interactionToAction(
          { type: 'pointerstroke', cells: completed.cells },
          { roomEditMode: current().ui.roomEditMode },
        );
        if (action) dispatch(action);
        else render();
        return;
      }
      if (completed.kind === 'pan') {
        render();
        return;
      }
      const screen = canvasPoint(event);
      const point = worldPoint(screen) || completed.preview;
      if (!point) {
        render();
        return;
      }
      if (completed.kind === 'source') {
        const source = sourceById(completed.id);
        const action = interactionToAction(
          { type: 'sourcedrop', id: completed.id, point, inside: pointInsideRoom(point) },
          {},
        );
        dispatch(action);
        if (action.type === 'source/remove' && source) {
          showRemovalNotice(suppliedDependencies.SOURCE_TYPES[source.type].label);
        }
        return;
      }
      if (completed.kind === 'listening') {
        const action = interactionToAction(
          { type: 'listeningdrop', point, inside: pointInsideRoom(point) },
          {},
        );
        if (action) dispatch(action);
        else render();
      }
    };

    listen(canvas, 'pointerdown', event => {
      if (event.button !== 0 || drag) return;
      const screen = canvasPoint(event);
      const hit = hitAt(screen);
      if (current().ui.roomEditMode) {
        const cell = worldCell(screen);
        if (!cell) return;
        drag = {
          kind: 'room',
          pointerId: event.pointerId,
          cells: [cell],
          seen: new Set([`${cell.x},${cell.y}`]),
          lastCell: cell,
          overflow: false,
        };
      } else if (hit?.kind === 'source') {
        dispatch({ type: 'ui/select-source', id: hit.id });
        drag = { kind: 'source', pointerId: event.pointerId, id: hit.id, preview: null };
      } else if (hit?.kind === 'listening-point') {
        dispatch({ type: 'ui/select-listening' });
        drag = { kind: 'listening', pointerId: event.pointerId, preview: null };
      } else if (hit?.kind === 'cell' && hit.filled) {
        dispatch({ type: 'ui/select-listening' });
        drag = { kind: 'listening', pointerId: event.pointerId, preview: worldPoint(screen) };
      } else {
        drag = {
          kind: 'pan',
          pointerId: event.pointerId,
          start: screen,
          initialPan: { ...current().ui.pan },
        };
      }
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    listen(canvas, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const screen = canvasPoint(event);
      if (!screen) return;
      if (drag.kind === 'room') {
        const cell = worldCell(screen);
        if (!cell) return;
        appendRoomCells(drag, cell);
      } else if (drag.kind === 'source' || drag.kind === 'listening') {
        drag.preview = worldPoint(screen);
        render();
      } else if (drag.kind === 'pan') {
        dispatch({
          type: 'ui/pan',
          x: drag.initialPan.x + screen.x - drag.start.x,
          y: drag.initialPan.y + screen.y - drag.start.y,
        });
      }
      event.preventDefault();
    });
    listen(canvas, 'pointerup', event => finishDrag(event));
    listen(canvas, 'pointercancel', event => finishDrag(event, true));
    listen(canvas, 'lostpointercapture', event => finishDrag(event, true));
    listen(canvas, 'wheel', event => {
      if (!Number.isFinite(event.deltaY)) return;
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      dispatch({ type: 'ui/zoom', value: current().ui.zoom * factor });
      event.preventDefault();
    }, { passive: false });
    listen(canvas, 'dragover', event => event.preventDefault());
    listen(canvas, 'drop', event => {
      event.preventDefault();
      if (current().ui.roomEditMode) return;
      const type = event.dataTransfer?.getData('text/room-wave-source');
      if (!suppliedDependencies.SOURCE_TYPES[type]) return;
      const screen = canvasPoint(event);
      const point = worldPoint(screen);
      if (point && pointInsideRoom(point)) addSource(type, point);
      else setError('Drop sources inside an occupied room cell.');
    });
    listen(elements['source-library'], 'dragstart', event => {
      if (current().ui.roomEditMode) {
        event.preventDefault();
        return;
      }
      const type = dataTarget(event.target, 'sourceType')?.dataset.sourceType;
      if (!suppliedDependencies.SOURCE_TYPES[type] || !event.dataTransfer) return;
      event.dataTransfer.setData('text/room-wave-source', type);
      event.dataTransfer.effectAllowed = 'copy';
    });
    listen(elements['source-library'], 'click', event => {
      if (current().ui.roomEditMode) return;
      const type = dataTarget(event.target, 'sourceType')?.dataset.sourceType;
      if (type) addSource(type);
    });
    listen(elements.app, 'click', event => {
      const target = dataTarget(event.target, 'openDialog');
      const dialog = target ? document.getElementById(target.dataset.openDialog) : null;
      if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    });
    listen(elements['room-edit-mode'], 'change', event => {
      dispatch({ type: 'ui/room-edit', value: Boolean(event.target.checked) });
    });
    listen(elements['undo-button'], 'click', undo);
    listen(elements['redo-button'], 'click', redo);
    listen(elements['remove-undo'], 'click', () => {
      if (!removalUndoAvailable) return;
      undo();
      setPoliteStatus('Source removal undone.');
    });
    listen(elements['analysis-controls'], 'change', event => {
      if (event.target?.name === 'analysis-view') {
        dispatch({ type: 'analysis/set', key: 'view', value: event.target.value });
      }
    });
    listen(elements['frequency-control'], 'input', event => {
      dispatch({ type: 'analysis/set', key: 'frequency', value: Number(event.target.value) });
    });
    listen(elements['project-name'], 'input', event => {
      projectName = String(event.target.value).slice(0, 80);
    });
    listen(elements['object-list'], 'click', event => {
      if (current().ui.roomEditMode) return;
      const target = event.target;
      const action = target?.dataset?.action;
      if (action === 'select-source') {
        dispatch({ type: 'ui/select-source', id: target.dataset.id });
      } else if (action === 'select-listening') {
        dispatch({ type: 'ui/select-listening' });
      } else if (action === 'remove-source') {
        const source = sourceById(target.dataset.id);
        if (source) {
          dispatch({ type: 'source/remove', id: source.id });
          showRemovalNotice(suppliedDependencies.SOURCE_TYPES[source.type].label);
        }
      } else if (action === 'move-source') {
        const source = sourceById(target.dataset.id);
        if (!source) return;
        const point = {
          x: source.x + Number(target.dataset.dx),
          y: source.y + Number(target.dataset.dy),
        };
        if (pointInsideRoom(point)) {
          dispatch({ type: 'source/move', id: source.id, ...point });
        } else setError('Keyboard movement must remain inside the room.');
      } else if (action === 'move-listening') {
        const point = {
          x: current().listeningPoint.x + Number(target.dataset.dx),
          y: current().listeningPoint.y + Number(target.dataset.dy),
        };
        if (pointInsideRoom(point)) dispatch({ type: 'listening/move', ...point });
        else setError('Listening point movement must remain inside the room.');
      }
    });
    listen(elements['inspector-content'], 'change', event => {
      const control = event.target?.dataset?.control;
      const value = event.target?.value;
      const source = selectedSource();
      if (control === 'room-height') {
        dispatch({ type: 'room/configure', changes: { ceilingHeight: Number(value) } });
      } else if (control === 'room-absorption') {
        dispatch({ type: 'room/configure', changes: { absorption: Number(value) } });
      } else if (control === 'speed-of-sound') {
        dispatch({ type: 'room/configure', changes: { speedOfSound: Number(value) } });
      } else if (control === 'listening-height') {
        dispatch({ type: 'listening/move', z: Number(value) });
      } else if (source && control === 'source-gain') {
        dispatch({ type: 'source/configure', id: source.id, changes: { gainDb: Number(value) } });
      } else if (source && control === 'source-delay') {
        dispatch({ type: 'source/configure', id: source.id, changes: { delayMs: Number(value) } });
      } else if (source && control === 'source-height') {
        dispatch({ type: 'source/configure', id: source.id, changes: { z: Number(value) } });
      } else if (source && control === 'source-polarity') {
        dispatch({ type: 'source/configure', id: source.id, changes: { polarity: value } });
      } else if (source && control === 'source-rotation') {
        dispatch({ type: 'source/configure', id: source.id, changes: { rotation: Number(value) } });
      }
    });
    listen(elements['inspector-content'], 'click', event => {
      if (event.target?.dataset?.action === 'remove-selected-source') {
        const source = sourceById(event.target.dataset.id);
        if (source) {
          dispatch({ type: 'source/remove', id: source.id });
          showRemovalNotice(suppliedDependencies.SOURCE_TYPES[source.type].label);
        }
      }
    });
    listen(document, 'keydown', event => {
      const action = interactionToAction({
        key: event.key,
        targetTag: event.target?.tagName,
        targetEditable: Boolean(event.target?.isContentEditable),
      }, {
        selectedSource: selectedSource(),
        roomEditMode: current().ui.roomEditMode,
      });
      if (action) {
        dispatch(action);
        event.preventDefault();
      }
    });
    if (typeof view.addEventListener === 'function') {
      listen(view, 'resize', render);
    }

    render();

    return {
      getState: current,
      getHistory: () => history,
      getViewModel: viewModel,
      dispatch,
      undo,
      redo,
      render,
      setResult(nextResult) {
        result = nextResult;
        render();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (drag) {
          const pointerId = drag.pointerId;
          drag = null;
          releasePointer(pointerId);
        }
        hideRemovalNotice();
        for (const dispose of cleanup.splice(0)) dispose();
      },
    };
  };

  const boot = () => {
    if (typeof document === 'undefined' || !document.getElementById('app')) return;
    try {
      createApp(document, RoomWave);
    } catch (error) {
      const target = document.getElementById('error-status');
      if (target) {
        target.textContent = error instanceof Error ? error.message : String(error);
        target.hidden = false;
      }
    }
  };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }

  return { createApp, interactionToAction };
});
