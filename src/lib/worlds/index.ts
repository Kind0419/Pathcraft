/**
 * The world registry: four spaces, one picker.
 *
 * Everything downstream — solver, renderer, share link — asks this module for
 * a `World` and branches on `kind`. That is deliberate: a second model ("3D
 * mode") would eventually drift from the 2D one, and the whole point of the
 * adapter layer under `core/space` is that there is only ever one contract.
 *
 * `grid2d` entries wrap the existing `GridMap`s and keep their ids, so old
 * share links still resolve to the same three scenes.
 */
import type { GridMap, MapId, SpaceKind } from '../types'
import { MAPS, getMap } from '../maps'
import { fieldScene, voxelScene, type FieldScene, type VoxelScene } from './scenes'
import { fieldDistance, type Vec3 } from '../core/space'

export type VoxelKey = 'hangar' | 'shaft' | 'grove'
export type FieldKey = 'roundHall' | 'floatingGrove'
export type WorldId = MapId | VoxelKey | FieldKey

export interface WorldMeta {
  id: WorldId
  kind: SpaceKind
  name: string
  nameEn: string
  blurb: string
  blurbEn: string
}

export type World =
  | { kind: 'grid2d'; meta: WorldMeta; map: GridMap }
  | { kind: 'voxel3d'; meta: WorldMeta; scene: VoxelScene }
  | { kind: 'field2d'; meta: WorldMeta; scene: FieldScene }
  | { kind: 'field3d'; meta: WorldMeta; scene: FieldScene }

const VOXEL_META: Record<VoxelKey, Omit<WorldMeta, 'id' | 'kind'>> = {
  hangar: {
    name: '停机棚',
    nameEn: 'Hangar',
    blurb: '三格高的矮墙可以飞越，顶梁必须从下方穿过',
    blurbEn: 'A 3-voxel wall you can fly over, a ceiling beam you must fly under',
  },
  shaft: {
    name: '竖井',
    nameEn: 'Shaft',
    blurb: '两层楼板，开口在对角，只能垂直穿行',
    blurbEn: 'Two floor slabs with corner openings: the only way up is vertical',
  },
  grove: {
    name: '柱林',
    nameEn: 'Grove',
    blurb: '高低不一的柱子，路径要在三维里穿行',
    blurbEn: 'Pillars of varying height — the route has to weave through 3D space',
  },
}

const FIELD_META: Record<FieldKey, Omit<WorldMeta, 'id' | 'kind'>> = {
  roundHall: {
    name: '圆厅',
    nameEn: 'Round hall',
    blurb: '解析几何障碍，无栅格；距离场就是真实间隙',
    blurbEn: 'Analytic obstacles, no grid: clearance is the true signed distance',
  },
  floatingGrove: {
    name: '浮板',
    nameEn: 'Floating grove',
    blurb: '悬空球体与立柱，连续三维空间中的采样规划',
    blurbEn: 'Floating spheres and columns; sampling in continuous 3D',
  },
}

const META: WorldMeta[] = [
  ...MAPS.map((map) => ({
    id: map.id,
    kind: 'grid2d' as SpaceKind,
    name: map.name,
    nameEn: map.id === 'notch' ? 'Notch' : map.id === 'gate' ? 'Gate' : 'Clutter',
    blurb: map.description,
    blurbEn: map.description,
  })),
  ...(Object.keys(VOXEL_META) as VoxelKey[]).map((id) => ({
    id,
    kind: 'voxel3d' as SpaceKind,
    ...VOXEL_META[id],
  })),
  ...(Object.keys(FIELD_META) as FieldKey[]).map((id) => ({
    id,
    kind: (id === 'roundHall' ? 'field2d' : 'field3d') as SpaceKind,
    ...FIELD_META[id],
  })),
]

export const WORLDS = META

export const WORLD_GROUPS: Array<{ key: string; label: string; labelEn: string; ids: WorldId[] }> = [
  { key: 'grid2d', label: '栅格 2D', labelEn: 'Grid 2D', ids: MAPS.map((map) => map.id) },
  { key: 'voxel3d', label: '体素 3D', labelEn: 'Voxel 3D', ids: ['hangar', 'shaft', 'grove'] },
  { key: 'field', label: '连续场', labelEn: 'Continuous', ids: ['roundHall', 'floatingGrove'] },
]

const IDS = new Set<string>(META.map((meta) => meta.id))

export function isWorldId(value: string): value is WorldId {
  return IDS.has(value)
}

export function worldMeta(id: WorldId): WorldMeta {
  return META.find((meta) => meta.id === id) ?? META[0]
}

export function resolveWorld(id: WorldId): World {
  const meta = worldMeta(id)
  if (meta.kind === 'grid2d') {
    return { kind: 'grid2d', meta, map: getMap(id as MapId) }
  }
  if (meta.kind === 'voxel3d') {
    return { kind: 'voxel3d', meta, scene: voxelScene(id as VoxelKey) }
  }
  return {
    kind: meta.kind === 'field3d' ? 'field3d' : 'field2d',
    meta,
    scene: fieldScene(id as FieldKey),
  }
}

export function isThreeDimensional(id: WorldId): boolean {
  const kind = worldMeta(id).kind
  return kind === 'voxel3d' || kind === 'field3d'
}

/** Default start/goal of a 3D or field world, in world units. */
export function worldEndpoints(world: World): { start: { x: number; y: number; z: number }; goal: { x: number; y: number; z: number } } {
  if (world.kind === 'grid2d') {
    return {
      start: { x: world.map.start.x + 0.5, y: world.map.start.y + 0.5, z: 0 },
      goal: { x: world.map.goal.x + 0.5, y: world.map.goal.y + 0.5, z: 0 },
    }
  }
  return { start: { ...world.scene.start }, goal: { ...world.scene.goal } }
}

/**
 * Nearest point the planner can actually start from.
 *
 * Clicking in a perspective view is approximate by nature, and the nearest cell
 * to a click is often inside a wall or inside the safety radius. Rather than
 * reject the click, search outward in rings and take the closest legal point —
 * the same promise the 2D canvas makes when it snaps S/G off an obstacle.
 */
export function snapEndpoint(world: World, point: Vec3, pad = 0.9): Vec3 {
  if (world.kind === 'grid2d') {
    const cell = {
      x: Math.max(1, Math.min(world.map.width - 2, Math.round(point.x))),
      y: Math.max(1, Math.min(world.map.height - 2, Math.round(point.y))),
      z: 0,
    }
    return cell
  }

  if (world.kind === 'voxel3d') {
    const v = world.scene.volume
    const spacing = v.spacing
    const plane = v.width * v.height
    const free = (x: number, y: number, z: number) => {
      if (x < 1 || y < 1 || z < 1 || x >= v.width - 1 || y >= v.height - 1 || z >= v.depth) return false
      const index = z * plane + y * v.width + x
      if (v.cells[index] === 1) return false
      return v.clearance[index] >= pad / spacing
    }
    // floor, not round: cell (x, y) covers [x·spacing, (x+1)·spacing), so a point
    // at 0.9 belongs to cell 0. Rounding put picks one cell off near every edge.
    const cx = Math.floor(point.x / spacing)
    const cy = Math.floor(point.y / spacing)
    const cz = Math.max(1, Math.min(v.depth - 2, Math.floor(point.z / spacing)))
    for (let radius = 0; radius <= 14; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            // Only the shell, otherwise the search is cubic for no benefit.
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== radius) continue
            const x = cx + dx
            const y = cy + dy
            const z = Math.max(1, Math.min(v.depth - 2, cz + dz))
            if (free(x, y, z)) {
              return { x: x * spacing + spacing / 2, y: y * spacing + spacing / 2, z: z * spacing + spacing / 2 }
            }
          }
        }
      }
    }
    return { x: cx * spacing, y: cy * spacing, z: cz * spacing }
  }

  const space = world.scene.space
  const { min, max } = space.bounds
  const clamp = (value: number, low: number, high: number) => Math.max(low + 0.6, Math.min(high - 0.6, value))
  const test = (p: Vec3) => fieldDistance(space, p) >= pad
  const base = {
    x: clamp(point.x, min.x, max.x),
    y: clamp(point.y, min.y, max.y),
    z: space.dim === 3 ? clamp(point.z, min.z, max.z) : 0,
  }
  if (test(base)) return base
  const step = Math.max(0.25, world.scene.resolution)
  for (let radius = 1; radius <= 40; radius += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== radius) continue
          const candidate = {
            x: base.x + dx * step,
            y: base.y + dy * step,
            z: space.dim === 3 ? base.z + dz * step : 0,
          }
          if (test(candidate)) return candidate
        }
      }
    }
  }
  return base
}
