(function (root, factory) {
  const api = factory();
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function () {
  const MAX_ROOM_SPAN = 30;
  const cellKey = (x, y) => `${x},${y}`;
  const parseCell = key => key.split(',').map(Number);
  const neighbors = ([x, y]) => [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];

  const rectangleCells = (width, height) => {
    const cells = new Set();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) cells.add(cellKey(x, y));
    }
    return cells;
  };

  const roomBounds = cells => {
    if (!cells.size) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const key of cells) {
      const [x, y] = parseCell(key);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + 1);
      maxY = Math.max(maxY, y + 1);
    }
    return { minX, minY, maxX, maxY };
  };

  const flood = (start, allowed) => {
    const seen = new Set([cellKey(...start)]);
    const queue = [start];
    // Topology checks run after every edit stroke, so an index avoids Array#shift's repeated reindexing on large rooms.
    for (let index = 0; index < queue.length; index += 1) {
      for (const point of neighbors(queue[index])) {
        const key = cellKey(...point);
        if (!seen.has(key) && allowed(point)) {
          seen.add(key);
          queue.push(point);
        }
      }
    }
    return seen;
  };

  const analyzeTopology = cells => {
    if (!cells.size) return { connected: false, hasHole: false };

    const first = parseCell(cells.values().next().value);
    const connected = flood(first, point => cells.has(cellKey(...point))).size === cells.size;
    // Disconnected imported geometry can have enormous bounds; no hole result is useful until connectivity is valid.
    if (!connected) return { connected: false, hasHole: false };

    const bounds = roomBounds(cells);
    const outside = flood(
      [bounds.minX - 1, bounds.minY - 1],
      ([x, y]) => (
        x >= bounds.minX - 1 && x <= bounds.maxX
        && y >= bounds.minY - 1 && y <= bounds.maxY
        && !cells.has(cellKey(x, y))
      ),
    );

    let hasHole = false;
    for (let y = bounds.minY; y < bounds.maxY; y += 1) {
      for (let x = bounds.minX; x < bounds.maxX; x += 1) {
        const key = cellKey(x, y);
        if (!cells.has(key) && !outside.has(key)) hasHole = true;
      }
    }
    return { connected, hasHole };
  };

  const applyCellStroke = (cells, points) => {
    if (!points.length) return { cells, error: null };

    const next = new Set(cells);
    const firstKey = cellKey(points[0].x, points[0].y);
    const remove = next.has(firstKey);
    for (const { x, y } of points) {
      const key = cellKey(x, y);
      if (remove) next.delete(key);
      else next.add(key);
    }

    const bounds = roomBounds(next);
    if (bounds.maxX - bounds.minX > MAX_ROOM_SPAN || bounds.maxY - bounds.minY > MAX_ROOM_SPAN) {
      return { cells, error: 'Room cannot exceed 30 × 30 m.' };
    }

    const topology = analyzeTopology(next);
    if (!topology.connected) return { cells, error: 'Room must remain connected.' };
    if (topology.hasHole) return { cells, error: 'Room cannot contain an enclosed hole.' };
    return { cells: next, error: null };
  };

  const extractWallSegments = cells => {
    const groups = new Map();
    const add = (kind, fixed, start, nx, ny) => {
      const key = `${kind}:${fixed}:${nx}:${ny}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(start);
    };

    for (const key of cells) {
      const [x, y] = parseCell(key);
      if (!cells.has(cellKey(x, y - 1))) add('h', y, x, 0, -1);
      if (!cells.has(cellKey(x, y + 1))) add('h', y + 1, x, 0, 1);
      if (!cells.has(cellKey(x - 1, y))) add('v', x, y, -1, 0);
      if (!cells.has(cellKey(x + 1, y))) add('v', x + 1, y, 1, 0);
    }

    const segments = [];
    for (const [key, starts] of groups) {
      const [kind, fixedText, nxText, nyText] = key.split(':');
      const fixed = Number(fixedText);
      const nx = Number(nxText);
      const ny = Number(nyText);
      starts.sort((a, b) => a - b);

      let runStart = starts[0];
      let runEnd = runStart + 1;
      const push = () => {
        if (kind === 'h') segments.push({ ax: runStart, ay: fixed, bx: runEnd, by: fixed, nx, ny });
        else segments.push({ ax: fixed, ay: runStart, bx: fixed, by: runEnd, nx, ny });
      };

      for (const start of starts.slice(1)) {
        if (start === runEnd) runEnd += 1;
        else {
          push();
          runStart = start;
          runEnd = start + 1;
        }
      }
      push();
    }
    return segments;
  };

  return {
    cellKey,
    rectangleCells,
    roomBounds,
    analyzeTopology,
    applyCellStroke,
    extractWallSegments,
  };
});
