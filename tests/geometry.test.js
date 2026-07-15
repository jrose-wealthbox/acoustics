const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geometry.js');

const normalizeWalls = walls => walls.map(wall => {
  assert.deepEqual(Object.keys(wall).sort(), ['ax', 'ay', 'bx', 'by', 'nx', 'ny']);
  return [wall.ax, wall.ay, wall.bx, wall.by, wall.nx, wall.ny];
}).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

const assertWallSegments = (actual, expected) => {
  assert.deepEqual(normalizeWalls(actual), normalizeWalls(expected));
};

test('default rectangle contains 70 connected, hole-free cells', () => {
  const cells = G.rectangleCells(10, 7);
  assert.equal(cells.size, 70);
  assert.deepEqual(G.analyzeTopology(cells), { connected: true, hasHole: false });
});

test('disconnected topology returns before scanning its potentially huge bounds', () => {
  class ConnectivityOnlyCells extends Set {
    [Symbol.iterator]() {
      throw new Error('Disconnected geometry must not start a bounds-based hole scan.');
    }
  }
  const cells = new ConnectivityOnlyCells(['0,0', '1000000,1000000']);

  assert.deepEqual(G.analyzeTopology(cells), { connected: false, hasHole: false });
});

test('stroke toggles cells atomically and rejects a disconnected result', () => {
  const cells = G.rectangleCells(3, 1);
  assert.deepEqual([...G.applyCellStroke(cells, [{ x: 1, y: 0 }]).cells], [...cells]);
  assert.equal(G.applyCellStroke(cells, [{ x: 1, y: 0 }]).error, 'Room must remain connected.');
  const added = G.applyCellStroke(cells, [{ x: 1, y: 1 }]);
  assert.equal(added.cells.has('1,1'), true);
});

test('empty stroke is a controlled no-op', () => {
  const cells = G.rectangleCells(2, 1);
  const result = G.applyCellStroke(cells, []);

  assert.equal(result.cells, cells);
  assert.equal(result.error, null);
});

test('stroke rejects an enclosed hole without mutating the original cells', () => {
  const cells = G.rectangleCells(3, 3);
  const result = G.applyCellStroke(cells, [{ x: 1, y: 1 }]);

  assert.equal(result.cells, cells);
  assert.equal(cells.has('1,1'), true);
  assert.equal(result.error, 'Room cannot contain an enclosed hole.');
});

test('stroke atomically rejects excessive width before disconnected topology traversal', () => {
  const cells = G.rectangleCells(1, 1);
  const result = G.applyCellStroke(cells, [{ x: 1000000, y: 0 }]);

  assert.equal(result.cells, cells);
  assert.equal(cells.has('1000000,0'), false);
  assert.equal(result.error, 'Room cannot exceed 30 × 30 m.');
});

test('stroke atomically rejects a room taller than 30 meters', () => {
  const cells = G.rectangleCells(1, 30);
  const result = G.applyCellStroke(cells, [{ x: 0, y: 30 }]);

  assert.equal(result.cells, cells);
  assert.equal(cells.has('0,30'), false);
  assert.equal(result.error, 'Room cannot exceed 30 × 30 m.');
});

test('wall extraction returns exact merged outer segments for a rectangle', () => {
  assertWallSegments(G.extractWallSegments(G.rectangleCells(2, 1)), [
    { ax: 0, ay: 0, bx: 2, by: 0, nx: 0, ny: -1 },
    { ax: 0, ay: 1, bx: 2, by: 1, nx: 0, ny: 1 },
    { ax: 0, ay: 0, bx: 0, by: 1, nx: -1, ny: 0 },
    { ax: 2, ay: 0, bx: 2, by: 1, nx: 1, ny: 0 },
  ]);
});

test('empty room bounds and walls remain finite and well-formed', () => {
  const cells = new Set();

  assert.deepEqual(G.roomBounds(cells), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  assert.deepEqual(G.extractWallSegments(cells), []);
});

test('concave rooms produce exact merged wall segments with outward normals', () => {
  const cells = new Set(['0,0', '1,0', '0,1']);
  const walls = G.extractWallSegments(cells);

  assertWallSegments(walls, [
    { ax: 0, ay: 0, bx: 2, by: 0, nx: 0, ny: -1 },
    { ax: 1, ay: 1, bx: 2, by: 1, nx: 0, ny: 1 },
    { ax: 0, ay: 2, bx: 1, by: 2, nx: 0, ny: 1 },
    { ax: 0, ay: 0, bx: 0, by: 2, nx: -1, ny: 0 },
    { ax: 2, ay: 0, bx: 2, by: 1, nx: 1, ny: 0 },
    { ax: 1, ay: 1, bx: 1, by: 2, nx: 1, ny: 0 },
  ]);
  for (const wall of walls) {
    assert.equal(Object.values(wall).every(Number.isFinite), true);
    assert.equal(wall.ax === wall.bx || wall.ay === wall.by, true);
    assert.notDeepEqual([wall.ax, wall.ay], [wall.bx, wall.by]);
    assert.equal(Math.abs(wall.nx) + Math.abs(wall.ny), 1);
  }
});

test('opposite-facing contiguous collinear edges remain separate', () => {
  const walls = G.extractWallSegments(new Set(['0,0', '1,1']));

  assertWallSegments(walls, [
    { ax: 0, ay: 0, bx: 1, by: 0, nx: 0, ny: -1 },
    { ax: 0, ay: 1, bx: 1, by: 1, nx: 0, ny: 1 },
    { ax: 0, ay: 0, bx: 0, by: 1, nx: -1, ny: 0 },
    { ax: 1, ay: 0, bx: 1, by: 1, nx: 1, ny: 0 },
    { ax: 1, ay: 1, bx: 2, by: 1, nx: 0, ny: -1 },
    { ax: 1, ay: 2, bx: 2, by: 2, nx: 0, ny: 1 },
    { ax: 1, ay: 1, bx: 1, by: 2, nx: -1, ny: 0 },
    { ax: 2, ay: 1, bx: 2, by: 2, nx: 1, ny: 0 },
  ]);
});
