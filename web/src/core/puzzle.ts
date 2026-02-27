import { Cell, ExpectedEdge, PieceDef, Side, SwapPlan } from "./types";

const GRID_MODES = new Set(["grid", "grid_shuffle", "shuffle_grid"]);

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function buildPieces(rows: number, cols: number): PieceDef[] {
  const pieces: PieceDef[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const id = row * cols + col;
      pieces.push({
        id,
        correctRow: row,
        correctCol: col,
        correctId: [row, col],
      });
    }
  }
  return pieces;
}

export function buildExpectedEdges(rows: number, cols: number): Map<string, ExpectedEdge> {
  const edges = new Map<string, ExpectedEdge>();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const id = row * cols + col;
      if (col + 1 < cols) {
        const rightId = row * cols + (col + 1);
        edges.set(edgeKey(id, rightId), {
          firstId: id,
          secondId: rightId,
          dx: 1,
          dy: 0,
        });
      }
      if (row + 1 < rows) {
        const downId = (row + 1) * cols + col;
        edges.set(edgeKey(id, downId), {
          firstId: id,
          secondId: downId,
          dx: 0,
          dy: 1,
        });
      }
    }
  }
  return edges;
}

export function createInitialPieceCells(opts: {
  rows: number;
  cols: number;
  mode?: string;
  seed?: number;
}): Record<number, Cell> {
  const { rows, cols, mode, seed } = opts;
  const rng = mulberry32(seed ?? 42);

  const cells: Cell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells.push({ row, col });
    }
  }

  const gridMode = mode ? GRID_MODES.has(mode.trim().toLowerCase()) : true;
  const shuffled = gridMode ? shuffle(cells, rng) : shuffle(cells, rng);

  const result: Record<number, Cell> = {};
  for (let id = 0; id < shuffled.length; id += 1) {
    result[id] = shuffled[id];
  }
  return result;
}

export function groupForPiece(pieceId: number, lockedEdges: Set<string>, totalPieces: number): Set<number> {
  const adjacency: Map<number, Set<number>> = new Map();
  for (let id = 0; id < totalPieces; id += 1) {
    adjacency.set(id, new Set());
  }
  for (const key of lockedEdges) {
    const [a, b] = key.split("-").map(Number);
    adjacency.get(a)?.add(b);
    adjacency.get(b)?.add(a);
  }

  const visited = new Set<number>();
  const stack: number[] = [pieceId];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        stack.push(next);
      }
    }
  }
  return visited;
}

export function planSwap(opts: {
  firstIds: Set<number>;
  secondIds: Set<number>;
  pieceCells: Record<number, Cell>;
  rows: number;
  cols: number;
  requireFirstWithinBoard: boolean;
}): SwapPlan | null {
  const { firstIds, secondIds, pieceCells, rows, cols, requireFirstWithinBoard } = opts;
  if (firstIds.size === 0 || secondIds.size === 0) {
    return null;
  }

  const firstAnchor = anchor(firstIds, pieceCells);
  const secondAnchor = anchor(secondIds, pieceCells);

  const firstDelta = {
    row: secondAnchor.row - firstAnchor.row,
    col: secondAnchor.col - firstAnchor.col,
  };
  const secondDelta = {
    row: firstAnchor.row - secondAnchor.row,
    col: firstAnchor.col - secondAnchor.col,
  };

  const endCells: Record<number, Cell> = { ...pieceCells };
  for (const id of firstIds) {
    const cell = pieceCells[id];
    endCells[id] = {
      row: cell.row + firstDelta.row,
      col: cell.col + firstDelta.col,
    };
  }
  for (const id of secondIds) {
    const cell = pieceCells[id];
    endCells[id] = {
      row: cell.row + secondDelta.row,
      col: cell.col + secondDelta.col,
    };
  }

  if (requireFirstWithinBoard) {
    for (const id of firstIds) {
      if (!inside(endCells[id], rows, cols)) {
        return null;
      }
    }
  }

  for (const id of new Set([...firstIds, ...secondIds])) {
    if (!inside(endCells[id], rows, cols)) {
      return null;
    }
  }

  const occupied = new Set<string>();
  for (const cell of Object.values(endCells)) {
    const key = `${cell.row},${cell.col}`;
    if (occupied.has(key)) {
      return null;
    }
    occupied.add(key);
  }

  return {
    firstIds: new Set(firstIds),
    secondIds: new Set(secondIds),
    endCells,
  };
}

export function planSwapByTargetCell(opts: {
  firstIds: Set<number>;
  targetPieceId: number;
  pieceCells: Record<number, Cell>;
  rows: number;
  cols: number;
  requireFirstWithinBoard: boolean;
}): SwapPlan | null {
  const { firstIds, targetPieceId, pieceCells, rows, cols, requireFirstWithinBoard } = opts;
  if (firstIds.size === 0) {
    return null;
  }

  const targetAnchor = pieceCells[targetPieceId];
  if (!targetAnchor) {
    return null;
  }

  const firstAnchorPieceId = closestPieceIdToTarget(firstIds, pieceCells, targetAnchor);
  const firstAnchor = pieceCells[firstAnchorPieceId];

  const delta = {
    row: targetAnchor.row - firstAnchor.row,
    col: targetAnchor.col - firstAnchor.col,
  };
  if (delta.row === 0 && delta.col === 0) {
    return null;
  }

  const cellToPiece = new Map<string, number>();
  for (const [idStr, cell] of Object.entries(pieceCells)) {
    cellToPiece.set(cellKey(cell), Number(idStr));
  }

  type Offset = { row: number; col: number };
  const offsetsByFirstId = new Map<number, Offset>();
  for (const firstId of firstIds) {
    const cell = pieceCells[firstId];
    offsetsByFirstId.set(firstId, {
      row: cell.row - firstAnchor.row,
      col: cell.col - firstAnchor.col,
    });
  }

  const endCells: Record<number, Cell> = { ...pieceCells };
  const secondIds = new Set<number>();
  const secondEndById = new Map<number, Cell>();
  const firstFromById = new Map<number, Cell>();
  const firstToById = new Map<number, Cell>();

  for (const [firstId, offset] of offsetsByFirstId.entries()) {
    const fromCell = {
      row: firstAnchor.row + offset.row,
      col: firstAnchor.col + offset.col,
    };

    const toCell = {
      row: fromCell.row + delta.row,
      col: fromCell.col + delta.col,
    };

    if (!inside(toCell, rows, cols)) {
      return null;
    }
    if (requireFirstWithinBoard && !inside(toCell, rows, cols)) {
      return null;
    }

    endCells[firstId] = toCell;
    firstFromById.set(firstId, fromCell);
    firstToById.set(firstId, toCell);
  }

  const firstCellKeys = new Set<string>([...firstFromById.values()].map(cellKey));
  const targetCellKeys = new Set<string>([...firstToById.values()].map(cellKey));
  const vacatedCellKeys = new Set<string>([...firstCellKeys].filter((key) => !targetCellKeys.has(key)));
  const enteringCellKeys = [...targetCellKeys].filter((key) => !firstCellKeys.has(key));

  for (const enteringKey of enteringCellKeys) {
    const occupiedId = cellToPiece.get(enteringKey);
    if (occupiedId === undefined) {
      return null;
    }

    secondIds.add(occupiedId);

    let walkKey = enteringKey;
    const visited = new Set<string>();
    while (!vacatedCellKeys.has(walkKey)) {
      if (visited.has(walkKey)) {
        return null;
      }
      visited.add(walkKey);

      const walkCell = parseCellKey(walkKey);
      walkKey = cellKey({
        row: walkCell.row - delta.row,
        col: walkCell.col - delta.col,
      });

      if (!firstCellKeys.has(walkKey) && !vacatedCellKeys.has(walkKey)) {
        return null;
      }
    }

    secondEndById.set(occupiedId, parseCellKey(walkKey));
  }

  // Clicking inside selected shape means no swap target.
  if (secondIds.size === 0) {
    return null;
  }

  for (const [secondId, endCell] of secondEndById.entries()) {
    endCells[secondId] = endCell;
  }

  const occupiedAfter = new Set<string>();
  for (const cell of Object.values(endCells)) {
    const key = cellKey(cell);
    if (occupiedAfter.has(key)) {
      return null;
    }
    occupiedAfter.add(key);
  }

  return {
    firstIds: new Set(firstIds),
    secondIds,
    endCells,
  };
}

export function planSwapByDelta(opts: {
  firstIds: Set<number>;
  deltaRow: number;
  deltaCol: number;
  pieceCells: Record<number, Cell>;
  rows: number;
  cols: number;
  requireFirstWithinBoard: boolean;
}): SwapPlan | null {
  const { firstIds, deltaRow, deltaCol, pieceCells, rows, cols, requireFirstWithinBoard } = opts;
  if (firstIds.size === 0) {
    return null;
  }
  if (deltaRow === 0 && deltaCol === 0) {
    return null;
  }

  const firstAnchor = [...firstIds]
    .map((id) => pieceCells[id])
    .sort((a, b) => (a.col - b.col) || (a.row - b.row))[0];
  if (!firstAnchor) {
    return null;
  }

  const cellToPiece = new Map<string, number>();
  for (const [idStr, cell] of Object.entries(pieceCells)) {
    cellToPiece.set(cellKey(cell), Number(idStr));
  }

  type Offset = { row: number; col: number };
  const offsetsByFirstId = new Map<number, Offset>();
  for (const firstId of firstIds) {
    const cell = pieceCells[firstId];
    offsetsByFirstId.set(firstId, {
      row: cell.row - firstAnchor.row,
      col: cell.col - firstAnchor.col,
    });
  }

  const endCells: Record<number, Cell> = { ...pieceCells };
  const secondIds = new Set<number>();
  const secondEndById = new Map<number, Cell>();
  const firstFromById = new Map<number, Cell>();
  const firstToById = new Map<number, Cell>();

  for (const [firstId, offset] of offsetsByFirstId.entries()) {
    const fromCell = {
      row: firstAnchor.row + offset.row,
      col: firstAnchor.col + offset.col,
    };

    const toCell = {
      row: fromCell.row + deltaRow,
      col: fromCell.col + deltaCol,
    };

    if (!inside(toCell, rows, cols)) {
      return null;
    }
    if (requireFirstWithinBoard && !inside(toCell, rows, cols)) {
      return null;
    }

    endCells[firstId] = toCell;
    firstFromById.set(firstId, fromCell);
    firstToById.set(firstId, toCell);
  }

  const firstCellKeys = new Set<string>([...firstFromById.values()].map(cellKey));
  const targetCellKeys = new Set<string>([...firstToById.values()].map(cellKey));
  const vacatedCellKeys = new Set<string>([...firstCellKeys].filter((key) => !targetCellKeys.has(key)));
  const enteringCellKeys = [...targetCellKeys].filter((key) => !firstCellKeys.has(key));

  for (const enteringKey of enteringCellKeys) {
    const occupiedId = cellToPiece.get(enteringKey);
    if (occupiedId === undefined) {
      return null;
    }

    secondIds.add(occupiedId);

    let walkKey = enteringKey;
    const visited = new Set<string>();
    while (!vacatedCellKeys.has(walkKey)) {
      if (visited.has(walkKey)) {
        return null;
      }
      visited.add(walkKey);

      const walkCell = parseCellKey(walkKey);
      walkKey = cellKey({
        row: walkCell.row - deltaRow,
        col: walkCell.col - deltaCol,
      });

      if (!firstCellKeys.has(walkKey) && !vacatedCellKeys.has(walkKey)) {
        return null;
      }
    }

    secondEndById.set(occupiedId, parseCellKey(walkKey));
  }

  if (secondIds.size === 0) {
    return null;
  }

  for (const [secondId, endCell] of secondEndById.entries()) {
    endCells[secondId] = endCell;
  }

  const occupiedAfter = new Set<string>();
  for (const cell of Object.values(endCells)) {
    const key = cellKey(cell);
    if (occupiedAfter.has(key)) {
      return null;
    }
    occupiedAfter.add(key);
  }

  return {
    firstIds: new Set(firstIds),
    secondIds,
    endCells,
  };
}

export function lockAlignedEdgesForMoved(opts: {
  movedIds: Set<number>;
  pieceCells: Record<number, Cell>;
  expectedEdges: Map<string, ExpectedEdge>;
  lockedEdges: Set<string>;
}): { lockedEdges: Set<string>; addedCount: number } {
  const { movedIds, pieceCells, expectedEdges, lockedEdges } = opts;
  const next = new Set(lockedEdges);
  let addedCount = 0;

  for (const [key, spec] of expectedEdges.entries()) {
    if (next.has(key)) {
      continue;
    }
    if (!movedIds.has(spec.firstId) && !movedIds.has(spec.secondId)) {
      continue;
    }

    const first = pieceCells[spec.firstId];
    const second = pieceCells[spec.secondId];
    const dx = second.col - first.col;
    const dy = second.row - first.row;
    if (dx === spec.dx && dy === spec.dy) {
      next.add(key);
      addedCount += 1;
    }
  }

  return { lockedEdges: next, addedCount };
}

export function recomputeLockedEdges(opts: {
  pieceCells: Record<number, Cell>;
  expectedEdges: Map<string, ExpectedEdge>;
}): Set<string> {
  const { pieceCells, expectedEdges } = opts;
  const locked = new Set<string>();

  for (const [key, spec] of expectedEdges.entries()) {
    const first = pieceCells[spec.firstId];
    const second = pieceCells[spec.secondId];
    if (!first || !second) {
      continue;
    }

    const dx = second.col - first.col;
    const dy = second.row - first.row;
    if (dx === spec.dx && dy === spec.dy) {
      locked.add(key);
    }
  }

  return locked;
}

export function buildHiddenSides(opts: {
  pieceCount: number;
  lockedEdges: Set<string>;
  expectedEdges: Map<string, ExpectedEdge>;
}): Map<number, Set<Side>> {
  const { pieceCount, lockedEdges, expectedEdges } = opts;
  const hidden = new Map<number, Set<Side>>();
  for (let i = 0; i < pieceCount; i += 1) {
    hidden.set(i, new Set<Side>());
  }

  for (const key of lockedEdges) {
    const spec = expectedEdges.get(key);
    if (!spec) {
      continue;
    }
    if (spec.dx === 1 && spec.dy === 0) {
      hidden.get(spec.firstId)?.add("right");
      hidden.get(spec.secondId)?.add("left");
    } else if (spec.dy === 1 && spec.dx === 0) {
      hidden.get(spec.firstId)?.add("bottom");
      hidden.get(spec.secondId)?.add("top");
    }
  }
  return hidden;
}

export function isSolved(lockedEdges: Set<string>, expectedEdges: Map<string, ExpectedEdge>): boolean {
  return lockedEdges.size === expectedEdges.size;
}

function anchor(groupIds: Set<number>, pieceCells: Record<number, Cell>): Cell {
  const points = [...groupIds].map((id) => pieceCells[id]);
  points.sort((a, b) => (a.col - b.col) || (a.row - b.row));
  return points[0];
}

function closestPieceIdToTarget(
  groupIds: Set<number>,
  pieceCells: Record<number, Cell>,
  target: Cell,
): number {
  return [...groupIds].sort((a, b) => {
    const ca = pieceCells[a];
    const cb = pieceCells[b];
    const da = Math.abs(ca.row - target.row) + Math.abs(ca.col - target.col);
    const db = Math.abs(cb.row - target.row) + Math.abs(cb.col - target.col);
    if (da !== db) {
      return da - db;
    }
    if (ca.col !== cb.col) {
      return ca.col - cb.col;
    }
    return ca.row - cb.row;
  })[0];
}

function inside(cell: Cell, rows: number, cols: number): boolean {
  return cell.row >= 0 && cell.row < rows && cell.col >= 0 && cell.col < cols;
}

function cellKey(cell: Cell): string {
  return `${cell.row},${cell.col}`;
}

function parseCellKey(key: string): Cell {
  const [row, col] = key.split(",").map(Number);
  return { row, col };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
