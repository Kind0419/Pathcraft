import type { GridMap, MapId, Point } from './types'

export const MAP_LIMITS = {
  minWidth: 24,
  maxWidth: 72,
  minHeight: 18,
  maxHeight: 56,
  maxCells: 4032,
} as const

export function clampMapSize(width: number, height: number): {
  width: number
  height: number
} {
  let w = Math.round(width)
  let h = Math.round(height)
  w = Math.max(MAP_LIMITS.minWidth, Math.min(MAP_LIMITS.maxWidth, w))
  h = Math.max(MAP_LIMITS.minHeight, Math.min(MAP_LIMITS.maxHeight, h))
  while (w * h > MAP_LIMITS.maxCells) {
    if (w >= h && w > MAP_LIMITS.minWidth) w -= 1
    else if (h > MAP_LIMITS.minHeight) h -= 1
    else break
  }
  return { width: w, height: h }
}

export function resizeCells(
  source: Uint8Array,
  oldWidth: number,
  oldHeight: number,
  width: number,
  height: number,
): Uint8Array {
  const cells = new Uint8Array(width * height)
  const offsetX = Math.floor((width - oldWidth) / 2)
  const offsetY = Math.floor((height - oldHeight) / 2)
  // Copy the interior only: the old outer frame must not become an internal
  // wall when the canvas grows.
  for (let y = 1; y < oldHeight - 1; y += 1) {
    for (let x = 1; x < oldWidth - 1; x += 1) {
      const tx = x + offsetX
      const ty = y + offsetY
      if (tx <= 0 || ty <= 0 || tx >= width - 1 || ty >= height - 1) continue
      cells[ty * width + tx] = source[y * oldWidth + x]
    }
  }
  // Always keep a closed outer wall after a resize.
  for (let x = 0; x < width; x += 1) {
    cells[x] = 1
    cells[(height - 1) * width + x] = 1
  }
  for (let y = 0; y < height; y += 1) {
    cells[y * width] = 1
    cells[y * width + width - 1] = 1
  }
  return cells
}

export function findFreeCell(
  cells: Uint8Array,
  width: number,
  height: number,
  preferred: Point,
): Point {
  const startX = Math.max(1, Math.min(width - 2, Math.round(preferred.x)))
  const startY = Math.max(1, Math.min(height - 2, Math.round(preferred.y)))
  for (let radius = 0; radius < Math.max(width, height); radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const x = startX + dx
        const y = startY + dy
        if (x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1) continue
        if (cells[y * width + x] === 0) return { x, y }
      }
    }
  }
  return { x: startX, y: startY }
}

interface MapSpec {
  id: MapId
  name: string
  description: string
  width: number
  height: number
  start: Point
  goal: Point
  walls: Array<[x: number, y: number, w: number, h: number]>
}

const CELL_SIZE = 0.2

const SPECS: MapSpec[] = [
  {
    id: 'notch',
    name: '凹槽',
    description: '一个大 C 形障碍。关掉启发式后，搜索会同时向上下两侧铺开。',
    width: 44,
    height: 28,
    start: { x: 6, y: 14 },
    goal: { x: 37, y: 14 },
    walls: [
      [21, 5, 1, 18],
      [21, 5, 12, 1],
      [21, 22, 12, 1],
      [11, 8, 1, 3],
      [11, 18, 1, 3],
      [35, 7, 1, 3],
      [35, 19, 1, 3],
    ],
  },
  {
    id: 'gate',
    name: '窄门',
    description: '一道只有五格宽的墙门。安全半径和斜走开关会明显改变路径。',
    width: 44,
    height: 28,
    start: { x: 6, y: 14 },
    goal: { x: 37, y: 14 },
    walls: [
      [21, 1, 1, 11],
      [21, 17, 1, 10],
      [30, 6, 2, 3],
      [30, 19, 2, 3],
    ],
  },
  {
    id: 'clutter',
    name: '杂物场',
    description: '零散障碍，适合观察离墙代价和转弯代价怎么互相拉扯。',
    width: 44,
    height: 28,
    start: { x: 5, y: 14 },
    goal: { x: 38, y: 14 },
    walls: [
      [9, 6, 5, 2],
      [9, 20, 5, 2],
      [16, 4, 2, 6],
      [16, 18, 2, 6],
      [23, 11, 5, 6],
      [30, 6, 4, 2],
      [30, 20, 4, 2],
      [12, 12, 2, 4],
    ],
  },
]

function fillRect(
  cells: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx += 1) {
      cells[yy * width + xx] = 1
    }
  }
}

function computeClearance(
  cells: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const obstacles: Point[] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (cells[y * width + x] === 1) obstacles.push({ x, y })
    }
  }

  const clearance = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (cells[index] === 1) {
        clearance[index] = 0
        continue
      }
      let nearest = Number.POSITIVE_INFINITY
      for (const obstacle of obstacles) {
        const dx = x - obstacle.x
        const dy = y - obstacle.y
        const distance = Math.hypot(dx, dy)
        if (distance < nearest) nearest = distance
      }
      clearance[index] = Number.isFinite(nearest) ? nearest : 999
    }
  }
  return clearance
}

function buildMap(spec: MapSpec): GridMap {
  const { width, height } = spec
  const cells = new Uint8Array(width * height)

  // Outer wall keeps the scene readable and gives the map a definite edge.
  fillRect(cells, width, height, 0, 0, width, 1)
  fillRect(cells, width, height, 0, height - 1, width, 1)
  fillRect(cells, width, height, 0, 0, 1, height)
  fillRect(cells, width, height, width - 1, 0, 1, height)

  for (const [x, y, w, h] of spec.walls) {
    fillRect(cells, width, height, x, y, w, h)
  }

  cells[spec.start.y * width + spec.start.x] = 0
  cells[spec.goal.y * width + spec.goal.x] = 0

  return {
    ...spec,
    cells,
    clearance: computeClearance(cells, width, height),
    cellSize: CELL_SIZE,
  }
}

export const MAPS: GridMap[] = SPECS.map(buildMap)

export function getMap(id: MapId): GridMap {
  return MAPS.find((map) => map.id === id) ?? MAPS[0]
}

export function mapFromCells(
  base: GridMap,
  source: Uint8Array,
  width = base.width,
  height = base.height,
): GridMap {
  if (source.length !== width * height) return base
  const cells = new Uint8Array(source)

  // Keep a closed outer boundary even if a shared URL contains bad cells.
  for (let x = 0; x < width; x += 1) {
    cells[x] = 1
    cells[(height - 1) * width + x] = 1
  }
  for (let y = 0; y < height; y += 1) {
    cells[y * width] = 1
    cells[y * width + width - 1] = 1
  }

  return {
    ...base,
    width,
    height,
    cells,
    clearance: computeClearance(cells, width, height),
  }
}

export function mapPresetLabel(id: MapId): string {
  return getMap(id).name
}