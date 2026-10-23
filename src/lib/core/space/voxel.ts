/**
 * 3D voxel space.
 *
 * The step 2D cannot take: a raster says "this column is blocked, always",
 * while a voxel volume says "blocked up to z = 4, free above it". A drone can
 * fly over a low wall; a 2D cell grid forces it around. Modelling that is the
 * entire point of the 3D adapter, so the demo volume keeps some walls low on
 * purpose — otherwise 3D is just 2D with extra memory.
 *
 * Memory is the reason the 2D solver path is untouched: 44×28×12 is 14 784
 * voxels (fine), 44×28×40 is 49 280 (still fine), but a real 200³ volume is
 * 8 M voxels before clearance. The interface is designed for that: `cells` and
 * `clearance` are flat typed arrays, so a caller can hand in a `Uint8Array`
 * view over a streamed chunk and keep the rest on the server.
 */
import type { CardsState, GridMap } from '../../types'
import { costModelFrom } from './cost'
import { blockedWithRadius, makeLattice, type LatticeData } from './lattice'
import { edtClearance } from './edt'
import { sampleSegmentFree } from './grid'
import type { Lattice, SpaceMetric, Vec3 } from './types'

export interface VoxelVolume {
  width: number
  height: number
  depth: number
  /** World units per voxel. */
  spacing: number
  origin: Vec3
  /** 1 = blocked. */
  cells: Uint8Array
  /** Distance to the nearest blocked voxel, in voxels. */
  clearance: Float32Array
}

export function buildVolume(
  width: number,
  height: number,
  depth: number,
  cells: Uint8Array,
  spacing = 1,
  cap = 24,
): VoxelVolume {
  return {
    width,
    height,
    depth,
    spacing,
    origin: { x: 0, y: 0, z: 0 },
    cells,
    clearance: edtClearance(cells, { width, height, depth }, cap),
  }
}

/**
 * Extrude a 2D map into a volume where each column has its own ceiling.
 *
 * `heightOf(x, y)` returns how many voxels are blocked in that column (0 = free
 * air all the way down). Walls become pillars of varying height, which is what
 * a lidar scan of an outdoor map roughly looks like after thresholding.
 */
export function volumeFromMap(
  map: GridMap,
  depth: number,
  heightOf: (x: number, y: number, blocked: boolean) => number,
  spacing = 1,
): VoxelVolume {
  const cells = new Uint8Array(map.width * map.height * depth)
  const plane = map.width * map.height
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const blocked = map.cells[y * map.width + x] === 1
      const top = Math.max(0, Math.min(depth, Math.round(heightOf(x, y, blocked))))
      for (let z = 0; z < top; z += 1) cells[z * plane + y * map.width + x] = 1
    }
  }
  return buildVolume(map.width, map.height, depth, cells, spacing)
}

export function voxelMetric(volume: VoxelVolume, radius: number): SpaceMetric {
  const { width, height, depth, spacing, origin, cells, clearance } = volume

  const cellAt = (point: Vec3): number => {
    const x = Math.floor((point.x - origin.x) / spacing)
    const y = Math.floor((point.y - origin.y) / spacing)
    const z = Math.floor((point.z - origin.z) / spacing)
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) return -1
    return z * width * height + y * width + x
  }

  const free = (point: Vec3, pad = radius): boolean => {
    const index = cellAt(point)
    if (index < 0) return false
    if (cells[index] === 1) return false
    // `pad` arrives in world units; the field is in voxels.
    return pad <= 0 || clearance[index] >= pad / spacing - 1e-6
  }

  return {
    dim: 3,
    kind: 'voxel3d',
    bounds: {
      min: { ...origin },
      max: {
        x: origin.x + width * spacing,
        y: origin.y + height * spacing,
        z: origin.z + depth * spacing,
      },
    },
    clearanceCap: 24 * spacing,
    free,
    clearanceAt(point) {
      const index = cellAt(point)
      if (index < 0) return 0
      return clearance[index] * spacing
    },
    segmentFree(a, b, pad = radius) {
      // Half a voxel of sampling cannot tunnel through anything one voxel
      // thick, so a dense walk is both cheaper and easier to trust than a
      // 3D DDA on corner cases.
      return sampleSegmentFree(this, a, b, pad, spacing * 0.5)
    },
  }
}

export function voxelLattice(
  volume: VoxelVolume,
  cards: CardsState,
  lengthScale: number,
  goal: Vec3,
): Lattice {
  const cost = costModelFrom(cards, goal, lengthScale)
  const data: LatticeData = {
    dim: 3,
    kind: 'voxel3d',
    width: volume.width,
    height: volume.height,
    depth: volume.depth,
    spacing: volume.spacing,
    blocked: blockedWithRadius(volume.cells, volume.clearance, cost.radius),
    clearance: volume.clearance,
    metric: voxelMetric(volume, cost.radius),
    cost,
  }
  return makeLattice(data)
}
