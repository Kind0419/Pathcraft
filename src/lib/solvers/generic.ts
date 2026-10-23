/**
 * Dimension-agnostic graph search over any `Lattice`.
 *
 * This is the proof that the adapter seam works: one loop, no `DX`/`DY`, no
 * `width * y + x`. Feed it the 2D raster lattice, the voxel lattice or a virtual
 * lattice over an SDF and it produces the same shape of answer. The frozen 2D
 * solvers in `graph.ts` stay where they are — they are faster and their numbers
 * are already published — but new spaces go through this.
 *
 * State is `node × incoming direction` for the same reason as the 2D engine: a
 * turn penalty is a property of the edge you arrived on, so a node alone is not
 * enough state. That multiplies memory by (8+1) in 2D and (26+1) in 3D, which
 * is still a single `Float64Array`.
 */
import { MinHeap } from '../heap'
import type { Lattice, Neighbor, Vec3 } from '../core/space'
import { NO_DIR } from '../core/space'

export type SearchMode = 'astar' | 'dijkstra' | 'greedy' | 'bfs' | 'dfs'

export interface SearchOptions {
  mode: SearchMode
  /** World-space start and goal. Snapped to the nearest node. */
  start: Vec3
  goal: Vec3
  /** Goal region radius, in lattice units. */
  goalTolerance?: number
  /** Node expansion cap; stops and returns the best partial path. */
  budget?: number
}

export interface SearchOutcome {
  found: boolean
  /** Node ids, start first. */
  nodes: number[]
  /** World-space centres, start first. */
  path: Vec3[]
  expanded: number
  openAtEnd: number
  /** Sum of the edge costs actually walked. */
  cost: number
}

interface Node {
  key: number
  index: number
  dir: number
  g: number
  h: number
  priority: number
  seq: number
}

export function searchLattice(lattice: Lattice, options: SearchOptions): SearchOutcome {
  const { mode } = options
  const dirs = lattice.dirCount + 1
  const sentinel = dirs - 1
  const stateCount = lattice.length * dirs
  const gScore = new Float64Array(stateCount)
  gScore.fill(Number.POSITIVE_INFINITY)
  const closed = new Uint8Array(stateCount)
  const parent = new Int32Array(stateCount)
  parent.fill(-1)

  const startIndex = lattice.nearest(options.start)
  const goalIndex = lattice.nearest(options.goal)
  const tolerance = options.goalTolerance ?? 0

  const startKey = startIndex * dirs + sentinel
  gScore[startKey] = 0
  const startH = lattice.heuristic(startIndex)
  const heap = new MinHeap<Node>((a, b) => {
    if (Math.abs(a.priority - b.priority) > 1e-9) return a.priority - b.priority
    if (a.seq !== b.seq) return a.seq - b.seq
    return a.key - b.key
  })

  let sequence = 0
  heap.push({
    key: startKey,
    index: startIndex,
    dir: NO_DIR,
    g: 0,
    h: startH,
    priority: mode === 'dijkstra' || mode === 'bfs' || mode === 'dfs' ? 0 : startH,
    seq: sequence,
  })
  sequence += 1

  const scratch: Neighbor[] = []
  for (let i = 0; i < lattice.dirCount; i += 1) {
    scratch.push({ index: -1, dir: 0, step: 1, cost: 0 })
  }

  const goalCell: Vec3 = { x: 0, y: 0, z: 0 }
  lattice.cellOf(goalIndex, goalCell)
  const cell: Vec3 = { x: 0, y: 0, z: 0 }

  let expanded = 0
  let endKey = -1
  let openAtEnd = 0

  while (heap.size > 0) {
    const current = heap.pop() as Node
    if (closed[current.key] === 1) continue
    if (current.g > gScore[current.key] + 1e-9) continue
    closed[current.key] = 1
    expanded += 1

    lattice.cellOf(current.index, cell)
    const gap = Math.hypot(
      cell.x - goalCell.x,
      cell.y - goalCell.y,
      (cell.z - goalCell.z) * (lattice.dim === 3 ? 1 : 0),
    )
    if (gap <= tolerance + 1e-9 || current.index === goalIndex) {
      endKey = current.key
      openAtEnd = heap.size
      break
    }

    if (options.budget !== undefined && expanded > options.budget) {
      openAtEnd = heap.size
      break
    }

    const count = lattice.neighbors(current.index, current.dir, scratch)
    for (let i = 0; i < count; i += 1) {
      const edge = scratch[i]
      const nextKey = edge.index * dirs + edge.dir
      if (closed[nextKey] === 1) continue
      const tentative = current.g + edge.cost
      if (tentative + 1e-9 >= gScore[nextKey]) continue
      gScore[nextKey] = tentative
      parent[nextKey] = current.key
      const h = lattice.heuristic(edge.index)
      let priority = tentative + h
      if (mode === 'dijkstra') priority = tentative
      else if (mode === 'greedy') priority = h
      else if (mode === 'bfs') priority = sequence
      else if (mode === 'dfs') priority = -sequence
      heap.push({
        key: nextKey,
        index: edge.index,
        dir: edge.dir,
        g: tentative,
        h,
        priority,
        seq: sequence,
      })
      sequence += 1
    }
  }

  if (endKey < 0) {
    return { found: false, nodes: [], path: [], expanded, openAtEnd, cost: 0 }
  }

  const nodes: number[] = []
  let cursor = endKey
  let guard = 0
  while (cursor >= 0 && guard < stateCount) {
    nodes.push(Math.floor(cursor / dirs))
    cursor = parent[cursor]
    guard += 1
  }
  nodes.reverse()
  return {
    found: true,
    nodes,
    path: nodes.map((index) => lattice.pointOf(index)),
    expanded,
    openAtEnd,
    cost: gScore[endKey],
  }
}

export type { Lattice }
