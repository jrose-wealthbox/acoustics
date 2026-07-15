const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geometry.js');

test('default rectangle contains 70 connected, hole-free cells', () => {
  const cells = G.rectangleCells(10, 7);
  assert.equal(cells.size, 70);
  assert.deepEqual(G.analyzeTopology(cells), { connected: true, hasHole: false });
});

test('stroke toggles cells atomically and rejects a disconnected result', () => {
  const cells = G.rectangleCells(3, 1);
  assert.deepEqual([...G.applyCellStroke(cells, [{ x: 1, y: 0 }]).cells], [...cells]);
  assert.equal(G.applyCellStroke(cells, [{ x: 1, y: 0 }]).error, 'Room must remain connected.');
  const added = G.applyCellStroke(cells, [{ x: 1, y: 1 }]);
  assert.equal(added.cells.has('1,1'), true);
});

test('stroke rejects an enclosed hole without mutating the original cells', () => {
  const cells = G.rectangleCells(3, 3);
  const result = G.applyCellStroke(cells, [{ x: 1, y: 1 }]);

  assert.equal(result.cells, cells);
  assert.equal(cells.has('1,1'), true);
  assert.equal(result.error, 'Room cannot contain an enclosed hole.');
});

test('wall extraction returns four outer segments for a rectangle', () => {
  assert.equal(G.extractWallSegments(G.rectangleCells(2, 1)).length, 4);
});

test('empty room bounds and walls remain finite and well-formed', () => {
  const cells = new Set();

  assert.deepEqual(G.roomBounds(cells), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  assert.deepEqual(G.extractWallSegments(cells), []);
});

test('concave rooms produce merged, finite, axis-aligned wall segments', () => {
  const cells = new Set(['0,0', '1,0', '0,1']);
  const walls = G.extractWallSegments(cells);

  assert.equal(walls.length, 6);
  for (const wall of walls) {
    assert.equal(Object.values(wall).every(Number.isFinite), true);
    assert.equal(wall.ax === wall.bx || wall.ay === wall.by, true);
    assert.notDeepEqual([wall.ax, wall.ay], [wall.bx, wall.by]);
    assert.equal(Math.abs(wall.nx) + Math.abs(wall.ny), 1);
  }
});
