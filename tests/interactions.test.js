const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

require('../src/namespace.js');
require('../src/geometry.js');
const Sources = require('../src/sources.js');
const State = require('../src/state.js');
const I = require('../src/app.js');

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    if (force === false) this.values.delete(name);
    else this.values.add(name);
  }
}

class FakeElement {
  constructor(tagName = 'DIV', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.listeners = new Map();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.clientWidth = 800;
    this.clientHeight = 560;
    this.captured = [];
    this.released = [];
    this.open = false;
    this.ownerDocument = null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
  }

  dispatch(type, event = {}) {
    const prepared = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const listener of this.listeners.get(type) || []) listener(prepared);
    return prepared;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
    for (const child of children) child.ownerDocument = this.ownerDocument;
  }

  contains(candidate) {
    return candidate === this || this.children.some(child => child.contains?.(candidate));
  }

  querySelectorAll(selector) {
    const tagName = selector.toUpperCase();
    const matches = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.tagName === tagName) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getContext() {
    return { canvas: this };
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  setPointerCapture(pointerId) {
    this.captured.push(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.released.push(pointerId);
  }

  showModal() {
    this.open = true;
  }
}

const elementIds = [
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

const fakeDocument = () => {
  const elements = Object.fromEntries(elementIds.map(id => [
    id,
    new FakeElement(id.includes('canvas') || id === 'response-chart' ? 'CANVAS' : 'DIV', id),
  ]));
  elements['room-edit-mode'].tagName = 'INPUT';
  elements['frequency-control'].tagName = 'INPUT';
  elements['project-name'].tagName = 'INPUT';
  const document = {
    elements,
    defaultView: {
      devicePixelRatio: 1,
      listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      removeEventListener(type) { this.listeners.delete(type); },
      setTimeout,
      clearTimeout,
    },
    listeners: new Map(),
    activeElement: null,
    getElementById(id) { return elements[id] || null; },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      element.ownerDocument = this;
      return element;
    },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type) { this.listeners.delete(type); },
    dispatch(type, event = {}) {
      const prepared = {
        type,
        target: elements.app,
        preventDefault() {},
        ...event,
      };
      this.listeners.get(type)?.(prepared);
      return prepared;
    },
  };
  for (const element of Object.values(elements)) element.ownerDocument = document;
  return document;
};

const appDependencies = overrides => {
  let lastPlan = null;
  return {
    ...Sources,
    ...State,
    buildRenderPlan(project, _result, viewport) {
      lastPlan = {
        project,
        viewport,
        transform: { minX: 0, minY: 0, offsetX: 0, offsetY: 0, scale: 100 },
        sources: project.sources.map(source => ({
          ...source,
          screen: { x: source.x * 100, y: source.y * 100 },
          hitRadius: 12,
        })),
        listeningPoint: {
          ...project.listeningPoint,
          screen: { x: project.listeningPoint.x * 100, y: project.listeningPoint.y * 100 },
          hitRadius: 12,
        },
      };
      return lastPlan;
    },
    renderRoom() {},
    hitTest(_plan, point) {
      if (point.x < 100) return { kind: 'source', id: 'speaker-1' };
      return { kind: 'cell', x: Math.floor(point.x / 100), y: Math.floor(point.y / 100), filled: true };
    },
    getLastPlan: () => lastPlan,
    ...overrides,
  };
};

test('arrow keys rotate selected directional sources only outside inputs', () => {
  assert.deepEqual(
    I.interactionToAction(
      { key: 'ArrowRight', targetTag: 'CANVAS' },
      { selectedSource: { id: 'a', type: 'bookshelf' } },
    ),
    { type: 'source/rotate', id: 'a', delta: 45 },
  );
  assert.equal(
    I.interactionToAction(
      { key: 'ArrowRight', targetTag: 'INPUT' },
      { selectedSource: { id: 'a', type: 'bookshelf' } },
    ),
    null,
  );
  assert.equal(
    I.interactionToAction(
      { key: 'ArrowRight', targetTag: 'CANVAS' },
      { selectedSource: { id: 's', type: 'subwoofer' } },
    ),
    null,
  );
});

test('room edit pointer stroke becomes one immutable history action', () => {
  const cells = [{ x: 0, y: 7 }, { x: 1, y: 7 }];
  const action = I.interactionToAction(
    { type: 'pointerstroke', cells },
    { roomEditMode: true },
  );

  assert.deepEqual(action, { type: 'room/stroke', points: cells });
  assert.notEqual(action.points, cells);
  cells[0].x = 99;
  assert.equal(action.points[0].x, 0);
  assert.throws(
    () => I.interactionToAction(
      { type: 'pointerstroke', cells: Array.from({ length: 901 }, () => ({ x: 0, y: 0 })) },
      { roomEditMode: true },
    ),
    /900/i,
  );
});

test('escape exits room edit mode and source drops become move or remove actions', () => {
  assert.deepEqual(
    I.interactionToAction({ key: 'Escape', targetTag: 'CANVAS' }, { roomEditMode: true }),
    { type: 'ui/room-edit', value: false },
  );
  assert.deepEqual(
    I.interactionToAction(
      { type: 'sourcedrop', id: 'a', point: { x: 1.5, y: 2.5 }, inside: true },
      {},
    ),
    { type: 'source/move', id: 'a', x: 1.5, y: 2.5 },
  );
  assert.deepEqual(
    I.interactionToAction(
      { type: 'sourcedrop', id: 'a', point: { x: 4, y: 4 }, inside: false },
      {},
    ),
    { type: 'source/remove', id: 'a' },
  );
});

test('index contains the approved semantic workbench and accessibility regions', () => {
  const html = fs.readFileSync('src/index.html', 'utf8');

  assert.match(html, /<header[^>]+class="[^"]*topbar/i);
  assert.match(html, /<aside[^>]+aria-label="Source library"/i);
  assert.match(html, /<canvas[^>]+id="room-canvas"[^>]+tabindex="0"/i);
  assert.match(html, /<aside[^>]+id="context-inspector"/i);
  assert.match(html, /<section[^>]+class="[^"]*analysis-strip/i);
  assert.match(html, /<ul[^>]+id="object-list"/i);
  assert.match(html, /id="polite-status"[^>]+aria-live="polite"/i);
  assert.match(html, /class="calculation-summary"[^>]+role="status"[^>]+aria-live="polite"/i);
  assert.match(html, /id="error-status"[^>]+role="alert"/i);
  assert.match(html, /id="error-status"[^>]+class="error-banner"[^>]+role="alert"[^>]+hidden/i);
  assert.match(html, /<details[^>]+id="methodology"/i);
  assert.match(html, /<dialog[^>]+id="preset-dialog"/i);
  assert.match(html, /<dialog[^>]+id="project-dialog"/i);
  assert.equal((html.match(/data-source-type=/g) || []).length, 5);
  assert.match(html, />Listening point</i);
});

test('createApp maintains history, gates analysis, and renders synchronized objects', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());

  assert.equal(app.getState().room.cells.size, 70);
  assert.equal(app.getViewModel().analysisDisabled, true);

  app.dispatch({
    type: 'source/add',
    source: { id: 'speaker-1', type: 'bookshelf', x: 0.5, y: 0.5 },
  });
  assert.equal(app.getState().sources.length, 1);
  assert.equal(app.getViewModel().analysisDisabled, false);
  assert.equal(document.elements['object-list'].children.length, 2);

  app.dispatch({ type: 'source/remove', id: 'speaker-1' });
  assert.equal(app.getState().sources.length, 0);
  app.undo();
  assert.equal(app.getState().sources.length, 1);

  app.dispatch({ type: 'source/move', id: 'speaker-1', x: 20.5, y: 20.5 });
  assert.equal(app.getViewModel().analysisDisabled, true);
  assert.match(app.getViewModel().analysisReason, /outside/i);
  assert.match(
    document.elements['object-list'].children[1].children[0].textContent,
    /outside/i,
  );

  app.destroy();
});

test('canvas source drag uses pointer capture and commits one move on release', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  app.dispatch({
    type: 'source/add',
    source: { id: 'speaker-1', type: 'bookshelf', x: 0.5, y: 0.5 },
  });
  const canvas = document.elements['room-canvas'];

  canvas.dispatch('pointerdown', { pointerId: 7, button: 0, clientX: 50, clientY: 50 });
  canvas.dispatch('pointermove', { pointerId: 7, clientX: 150, clientY: 150 });
  canvas.dispatch('pointerup', { pointerId: 7, clientX: 150, clientY: 150 });

  assert.deepEqual(canvas.captured, [7]);
  assert.deepEqual(canvas.released, [7]);
  assert.equal(app.getState().sources[0].x, 1.5);
  assert.equal(app.getState().sources[0].y, 1.5);
  assert.equal(app.getHistory().past.length, 2);

  app.destroy();
});

test('keyboard controls place and rotate sources, exit editing, and open dialogs', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  const sourceButton = new FakeElement('BUTTON');
  sourceButton.dataset.sourceType = 'bookshelf';

  document.elements['source-library'].dispatch('click', { target: sourceButton });
  assert.equal(app.getState().sources.length, 1);
  assert.equal(app.getState().ui.selectedSourceId, 'bookshelf-1');

  document.dispatch('keydown', {
    key: 'ArrowRight',
    target: document.elements['room-canvas'],
  });
  assert.equal(app.getState().sources[0].rotation, 45);

  const edit = document.elements['room-edit-mode'];
  edit.checked = true;
  edit.dispatch('change');
  assert.equal(app.getState().ui.roomEditMode, true);
  document.dispatch('keydown', { key: 'Escape', target: document.elements['room-canvas'] });
  assert.equal(app.getState().ui.roomEditMode, false);

  const dialogButton = new FakeElement('BUTTON');
  dialogButton.dataset.openDialog = 'preset-dialog';
  document.elements.app.dispatch('click', { target: dialogButton });
  assert.equal(document.elements['preset-dialog'].open, true);

  app.destroy();
});

test('captured room pointer stroke commits exactly one history entry', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  const edit = document.elements['room-edit-mode'];
  const canvas = document.elements['room-canvas'];
  edit.checked = true;
  edit.dispatch('change');

  canvas.dispatch('pointerdown', { pointerId: 11, button: 0, clientX: 150, clientY: 750 });
  canvas.dispatch('pointermove', { pointerId: 11, clientX: 250, clientY: 750 });
  canvas.dispatch('pointerup', { pointerId: 11, clientX: 250, clientY: 750 });

  assert.equal(app.getState().room.cells.size, 72);
  assert.equal(app.getHistory().past.length, 1);
  assert.deepEqual(canvas.captured, [11]);
  assert.deepEqual(canvas.released, [11]);

  app.destroy();
});

test('room editing paints through occupied cells and fills skipped pointer samples', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  app.dispatch({
    type: 'source/add',
    source: { id: 'speaker-1', type: 'bookshelf', x: 0.5, y: 0.5 },
  });
  const edit = document.elements['room-edit-mode'];
  const canvas = document.elements['room-canvas'];
  edit.checked = true;
  edit.dispatch('change');

  canvas.dispatch('pointerdown', { pointerId: 13, button: 0, clientX: 50, clientY: 50 });
  canvas.dispatch('pointermove', { pointerId: 13, clientX: 350, clientY: 350 });
  canvas.dispatch('pointerup', { pointerId: 13, clientX: 350, clientY: 350 });

  for (const key of ['0,0', '1,0', '1,1', '2,1', '2,2', '3,2', '3,3']) {
    assert.equal(app.getState().room.cells.has(key), false, key);
  }
  assert.equal(app.getState().sources.length, 1);
  assert.equal(app.getViewModel().invalidSources.length, 1);
  assert.equal(app.getHistory().past.length, 2);

  app.destroy();
});

test('captured room strokes stay within the declared work budget', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  const edit = document.elements['room-edit-mode'];
  const canvas = document.elements['room-canvas'];
  edit.checked = true;
  edit.dispatch('change');

  canvas.dispatch('pointerdown', { pointerId: 17, button: 0, clientX: 150, clientY: 750 });
  for (let index = 2; index <= 901; index += 1) {
    canvas.dispatch('pointermove', {
      pointerId: 17,
      clientX: index * 100 + 50,
      clientY: 750,
    });
  }

  assert.doesNotThrow(() => {
    canvas.dispatch('pointerup', { pointerId: 17, clientX: 90150, clientY: 750 });
  });
  assert.deepEqual(canvas.released, [17]);
  assert.equal(app.getState().room.cells.size, 70);
  assert.equal(app.getHistory().past.length, 0);
  assert.match(app.getState().ui.message, /900|limit/i);
  assert.equal(document.elements['error-status'].hidden, false);
  assert.match(document.elements['error-status'].textContent, /900|limit/i);

  app.destroy();
});

test('one extreme pointer jump is rejected before an unbounded raster allocation', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  const edit = document.elements['room-edit-mode'];
  const canvas = document.elements['room-canvas'];
  edit.checked = true;
  edit.dispatch('change');
  canvas.dispatch('pointerdown', { pointerId: 19, button: 0, clientX: 150, clientY: 750 });

  const originalPush = Array.prototype.push;
  Array.prototype.push = function (...values) {
    if (this.length >= 1000) throw new Error('unbounded raster allocation');
    return originalPush.apply(this, values);
  };
  try {
    assert.doesNotThrow(() => {
      canvas.dispatch('pointermove', { pointerId: 19, clientX: 200050, clientY: 750 });
    });
  } finally {
    Array.prototype.push = originalPush;
  }
  canvas.dispatch('pointerup', { pointerId: 19, clientX: 200050, clientY: 750 });

  assert.equal(app.getState().room.cells.size, 70);
  assert.equal(app.getHistory().past.length, 0);
  assert.match(app.getState().ui.message, /900|limit/i);

  app.destroy();
});

test('lost pointer capture cancels a drag and destroy releases active capture', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  const canvas = document.elements['room-canvas'];

  canvas.dispatch('pointerdown', { pointerId: 31, button: 0, clientX: 150, clientY: 150 });
  canvas.dispatch('lostpointercapture', { pointerId: 31 });
  canvas.dispatch('pointerdown', { pointerId: 32, button: 0, clientX: 150, clientY: 150 });

  assert.deepEqual(canvas.captured, [31, 32]);
  app.destroy();
  assert.deepEqual(canvas.released, [31, 32]);
});

test('dragging a source off-room removes it through an undoable notice', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  app.dispatch({
    type: 'source/add',
    source: { id: 'speaker-1', type: 'bookshelf', x: 0.5, y: 0.5 },
  });
  const canvas = document.elements['room-canvas'];

  canvas.dispatch('pointerdown', { pointerId: 21, button: 0, clientX: 50, clientY: 50 });
  canvas.dispatch('pointermove', { pointerId: 21, clientX: 1500, clientY: 150 });
  canvas.dispatch('pointerup', { pointerId: 21, clientX: 1500, clientY: 150 });

  assert.equal(app.getState().sources.length, 0);
  assert.equal(document.elements['remove-notice'].hidden, false);
  assert.match(document.elements['polite-status'].textContent, /undo/i);

  document.elements['remove-undo'].dispatch('click');
  assert.equal(app.getState().sources.length, 1);
  assert.equal(document.elements['remove-notice'].hidden, true);

  app.destroy();
});

test('removal notice cannot undo a later history action', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  app.dispatch({
    type: 'source/add',
    source: { id: 'speaker-1', type: 'bookshelf', x: 0.5, y: 0.5 },
  });
  const canvas = document.elements['room-canvas'];
  canvas.dispatch('pointerdown', { pointerId: 41, button: 0, clientX: 50, clientY: 50 });
  canvas.dispatch('pointerup', { pointerId: 41, clientX: 1500, clientY: 150 });
  app.dispatch({ type: 'analysis/set', key: 'frequency', value: 80 });

  assert.equal(document.elements['remove-notice'].hidden, true);
  document.elements['remove-undo'].dispatch('click');
  assert.equal(app.getState().analysis.frequency, 80);
  assert.equal(app.getState().sources.length, 0);

  app.destroy();
});

test('object-list movement keeps focus and exposes contextual button names', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  app.dispatch({
    type: 'source/add',
    source: { id: 'speaker-1', type: 'bookshelf', x: 0.5, y: 0.5 },
  });
  const moveRight = document.elements['object-list'].children[1].children[2];
  assert.equal(moveRight.attributes.get('aria-label'), 'Move Bookshelf speaker right');
  moveRight.focus();
  document.elements['object-list'].dispatch('click', { target: moveRight });

  assert.equal(app.getState().sources[0].x, 0.75);
  assert.equal(document.activeElement.dataset.action, 'move-source');
  assert.equal(document.activeElement.dataset.id, 'speaker-1');
  assert.equal(document.activeElement.dataset.dx, 0.25);

  app.destroy();
});

test('inspector controls keep focus across their state update render', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  app.dispatch({
    type: 'source/add',
    source: { id: 'speaker-1', type: 'bookshelf', x: 0.5, y: 0.5 },
  });
  app.dispatch({ type: 'ui/select-source', id: 'speaker-1' });
  const polarity = document.elements['inspector-content'].children[3].children[1];
  polarity.focus();
  polarity.value = 'inverted';
  document.elements['inspector-content'].dispatch('change', { target: polarity });

  assert.equal(app.getState().sources[0].polarity, 'inverted');
  assert.equal(document.activeElement.dataset.control, 'source-polarity');
  assert.notEqual(document.activeElement, polarity);

  app.destroy();
});

test('room edit mode blocks source manipulation and clears rotation selection', () => {
  const document = fakeDocument();
  const libraryButton = new FakeElement('BUTTON');
  libraryButton.ownerDocument = document;
  libraryButton.dataset.sourceType = 'bookshelf';
  document.elements['source-library'].append(libraryButton);
  const app = I.createApp(document, appDependencies());
  app.dispatch({
    type: 'source/add',
    source: { id: 'speaker-1', type: 'bookshelf', x: 0.5, y: 0.5 },
  });
  app.dispatch({ type: 'ui/select-source', id: 'speaker-1' });
  app.dispatch({ type: 'ui/room-edit', value: true });

  assert.equal(app.getState().ui.selectedSourceId, null);
  assert.equal(libraryButton.disabled, true);
  document.elements['source-library'].dispatch('click', { target: libraryButton });
  document.dispatch('keydown', { key: 'ArrowRight', target: document.elements['room-canvas'] });
  const moveRight = document.elements['object-list'].children[1].children[2];
  document.elements['object-list'].dispatch('click', { target: moveRight });

  assert.equal(app.getState().sources.length, 1);
  assert.equal(app.getState().sources[0].rotation, 0);
  assert.equal(app.getState().sources[0].x, 0.5);

  app.destroy();
});

test('pan dispatch rejects renderer-invalid values without changing state', () => {
  const document = fakeDocument();
  const app = I.createApp(document, appDependencies());
  const before = app.getState();

  assert.throws(
    () => app.dispatch({ type: 'ui/pan', x: 1_000_001, y: 0 }),
    /1,000,000/,
  );
  assert.equal(app.getState(), before);

  app.destroy();
});

test('room edit mode can recover an empty room with the first grid cell', () => {
  const document = fakeDocument();
  const initialProject = State.createDefaultProject();
  initialProject.room.cells = new Set();
  const app = I.createApp(document, appDependencies({
    initialProject,
    buildRenderPlan(project, _result, viewport) {
      return {
        project,
        viewport,
        transform: null,
        sources: [],
        listeningPoint: null,
        roomCells: [],
      };
    },
    hitTest() { return null; },
  }));
  const canvas = document.elements['room-canvas'];
  app.dispatch({ type: 'ui/room-edit', value: true });
  canvas.dispatch('pointerdown', { pointerId: 51, button: 0, clientX: 400, clientY: 280 });
  canvas.dispatch('pointerup', { pointerId: 51, clientX: 400, clientY: 280 });

  assert.deepEqual([...app.getState().room.cells], ['0,0']);
  assert.equal(app.getHistory().past.length, 1);

  app.destroy();
});

test('automatic boot exposes startup failures through the alert banner', () => {
  const script = `
    const elements = {
      app: {},
      'error-status': { hidden: true, textContent: '' },
    };
    global.document = {
      readyState: 'complete',
      getElementById(id) { return elements[id] || null; },
      createElement() { return {}; },
    };
    require('./src/app.js');
    if (elements['error-status'].hidden) throw new Error('startup alert stayed hidden');
    if (!elements['error-status'].textContent) throw new Error('startup alert stayed empty');
  `;

  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['-e', script], { cwd: process.cwd() });
  });
});
