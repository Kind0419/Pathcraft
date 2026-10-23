/**
 * 3D and continuous demo worlds.
 *
 * All of them are generated, not authored: a voxel scene is a few hundred bytes
 * of `paintBox` calls, so a share link never has to carry a volume, and the
 * clearance field is rebuilt on load with the exact EDT. That keeps the app
 * honest about what it costs to change a world — you edit the recipe, not an
 * asset.
 *
 * The two voxel scenes exist to make the *reason* for 3D visible:
 *
 *   hangar — a 3-high wall you can fly over and a ceiling beam you must fly
 *            under. In 2D the wall is impassable, so the 2D route has to go
 *            around it; the 3D route is measurably shorter.
 *   shaft  — two floor slabs, each with an opening in a different corner. The
 *            lower one is sealed all the way to the perimeter, so ground-level
 *            search can never reach the top floor: the only way up is vertical,
 *            through two offset holes.
 */
import { buildVolume, type FieldSpace, type Primitive, type Vec3, type VoxelVolume } from '../core/space'

export function emptyCells(width: number, height: number, depth: number): Uint8Array {
  return new Uint8Array(width * height * depth)
}

/** Inclusive box, clamped to the volume. */
export function paintBox(
  cells: Uint8Array,
  width: number,
  height: number,
  depth: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  value = 1,
): void {
  const plane = width * height
  const ax = Math.max(0, Math.min(width - 1, Math.min(x0, x1)))
  const bx = Math.max(0, Math.min(width - 1, Math.max(x0, x1)))
  const ay = Math.max(0, Math.min(height - 1, Math.min(y0, y1)))
  const by = Math.max(0, Math.min(height - 1, Math.max(y0, y1)))
  const az = Math.max(0, Math.min(depth - 1, Math.min(z0, z1)))
  const bz = Math.max(0, Math.min(depth - 1, Math.max(z0, z1)))
  for (let z = az; z <= bz; z += 1) {
    for (let y = ay; y <= by; y += 1) {
      const row = z * plane + y * width
      for (let x = ax; x <= bx; x += 1) cells[row + x] = value
    }
  }
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** A one-voxel slab over `rect` with a rectangular opening — the "floor with a hole". */
function paintSlab(
  cells: Uint8Array,
  width: number,
  height: number,
  depth: number,
  rect: Rect,
  z: number,
  hole: Rect,
): void {
  paintBox(cells, width, height, depth, rect.x0, rect.y0, z, rect.x1, rect.y1, z)
  paintBox(cells, width, height, depth, hole.x0, hole.y0, z, hole.x1, hole.y1, z, 0)
}

const HANGAR = { width: 36, height: 26, depth: 14 }
const SHAFT = { width: 28, height: 22, depth: 17 }
const GROVE = { width: 30, height: 22, depth: 12 }

function hangar(): VoxelVolume {
  const { width, height, depth } = HANGAR
  const cells = emptyCells(width, height, depth)

  // Ground and a *low* perimeter. A full-height wall would enclose the scene and
  // the camera would only ever see its outside; five voxels reads as a boundary
  // while keeping the interior open.
  paintBox(cells, width, height, depth, 0, 0, 0, width - 1, height - 1, 0)
  paintBox(cells, width, height, depth, 0, 0, 0, 0, height - 1, 4)
  paintBox(cells, width, height, depth, width - 1, 0, 0, width - 1, height - 1, 4)
  paintBox(cells, width, height, depth, 0, 0, 0, width - 1, 0, 4)
  paintBox(cells, width, height, depth, 0, height - 1, 0, width - 1, height - 1, 4)

  // The wall 2D cannot cross: 3 voxels high, spanning the room.
  paintBox(cells, width, height, depth, 3, 12, 1, width - 4, 13, 3)

  // Ceiling beam: forces the route to drop under it instead of hugging the roof.
  paintBox(cells, width, height, depth, 6, 5, 10, width - 7, 7, 11)

  // Columns. Full height on purpose — they are obstacles in both views.
  for (const [cx, cy] of [
    [10, 5],
    [24, 18],
    [10, 18],
    [24, 5],
  ]) {
    paintBox(cells, width, height, depth, cx, cy, 1, cx + 1, cy + 1, depth - 1)
  }

  return buildVolume(width, height, depth, cells, 1, 20)
}

function shaft(): VoxelVolume {
  const { width, height, depth } = SHAFT
  const cells = emptyCells(width, height, depth)

  paintBox(cells, width, height, depth, 0, 0, 0, width - 1, height - 1, 0)
  paintBox(cells, width, height, depth, 0, 0, 0, 0, height - 1, depth - 1)
  paintBox(cells, width, height, depth, width - 1, 0, 0, width - 1, height - 1, depth - 1)
  paintBox(cells, width, height, depth, 0, 0, 0, width - 1, 0, depth - 1)
  paintBox(cells, width, height, depth, 0, height - 1, 0, width - 1, height - 1, depth - 1)

  // Two floors, each with an opening in a corner the other cannot see.
  //
  // The lower one covers the *whole* footprint on purpose: a partial floor would
  // leave a gap along its edge and the robot could fly straight past it, which
  // collapses the three levels back into one open room. Being sealed means the
  // only way up from the ground is the opening at (2..8, 2..8).
  paintSlab(
    cells,
    width,
    height,
    depth,
    { x0: 1, y0: 1, x1: width - 2, y1: height - 2 },
    6,
    { x0: 2, y0: 2, x1: 8, y1: 8 },
  )

  // The upper one covers the back two thirds only. That is what makes the levels
  // *legible* from an isometric camera: the lower floor stays in view in front of
  // the step, instead of the volume top being one sealed surface. Its opening sits
  // above the lower floor, so the second climb still has to go through it.
  paintSlab(
    cells,
    width,
    height,
    depth,
    { x0: 1, y0: 8, x1: width - 2, y1: height - 2 },
    12,
    { x0: 19, y0: 14, x1: 25, y1: 19 },
  )

  return buildVolume(width, height, depth, cells, 1, 20)
}

function grove(): VoxelVolume {
  // A "pillar forest": many thin columns of different heights, so the trace has
  // to weave between them in 3D instead of following a 2D corridor.
  const { width, height, depth } = GROVE
  const cells = emptyCells(width, height, depth)
  paintBox(cells, width, height, depth, 0, 0, 0, width - 1, height - 1, 0)
  paintBox(cells, width, height, depth, 0, 0, 0, 0, height - 1, 4)
  paintBox(cells, width, height, depth, width - 1, 0, 0, width - 1, height - 1, 4)
  paintBox(cells, width, height, depth, 0, 0, 0, width - 1, 0, 4)
  paintBox(cells, width, height, depth, 0, height - 1, 0, width - 1, height - 1, 4)

  // Deterministic pseudo-random pillars: a hash keeps the scene identical on
  // every load without shipping a bitmap or a PRNG state.
  let seed = 0x2f6b1c3d
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0xffffffff
  }
  for (let i = 0; i < 26; i += 1) {
    const x = 3 + Math.floor(next() * (width - 8))
    const y = 3 + Math.floor(next() * (height - 8))
    const top = 3 + Math.floor(next() * (depth - 5))
    paintBox(cells, width, height, depth, x, y, 1, x + 1, y + 1, top)
  }

  return buildVolume(width, height, depth, cells, 1, 20)
}

export interface VoxelScene {
  key: 'hangar' | 'shaft' | 'grove'
  volume: VoxelVolume
  start: Vec3
  goal: Vec3
}

const VOXEL_CACHE = new Map<VoxelScene['key'], VoxelScene>()

export function voxelScene(key: VoxelScene['key']): VoxelScene {
  const cached = VOXEL_CACHE.get(key)
  if (cached) return cached
  const build = key === 'hangar' ? hangar : key === 'shaft' ? shaft : grove
  const volume = build()
  const scene: VoxelScene =
    key === 'hangar'
      ? { key, volume, start: { x: 4.5, y: 21.5, z: 1.5 }, goal: { x: 30.5, y: 4.5, z: 1.5 } }
      : key === 'shaft'
        ? { key, volume, start: { x: 23.5, y: 4.5, z: 1.5 }, goal: { x: 5.5, y: 17.5, z: 14.5 } }
        : { key, volume, start: { x: 3.5, y: 18.5, z: 1.5 }, goal: { x: 26.5, y: 3.5, z: 1.5 } }
  VOXEL_CACHE.set(key, scene)
  return scene
}

/* ------------------------------------------------------------------ fields */

const disc = (x: number, y: number, r: number): Primitive => ({ kind: 'disc', x, y, r })
const box = (x0: number, y0: number, x1: number, y1: number): Primitive => ({
  kind: 'box',
  x0,
  y0,
  x1,
  y1,
})
const sphere = (x: number, y: number, z: number, r: number): Primitive => ({
  kind: 'sphere',
  x,
  y,
  z,
  r,
})

/** Continuous 2D: a hall with round columns and two long walls. */
function roundHall(): FieldSpace {
  return {
    dim: 2,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 36, y: 26, z: 0 } },
    primitives: [
      box(-1, -1, 37, 0),
      box(-1, 26, 37, 27),
      box(-1, -1, 0, 27),
      box(36, -1, 37, 27),
      disc(9, 7, 3.2),
      disc(9, 19, 2.6),
      disc(18, 13, 4.4),
      disc(27, 6, 2.9),
      disc(27, 20, 3.4),
      { kind: 'capsule', ax: 13, ay: 22, bx: 23, by: 22, r: 1.1 },
      box(14, 2, 22, 5),
    ],
  }
}

/** Continuous 3D: floating slabs and columns, no grid anywhere. */
function floatingGrove(): FieldSpace {
  return {
    dim: 3,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 22, z: 12 } },
    primitives: [
      { kind: 'box3', min: { x: -1, y: -1, z: -1 }, max: { x: 31, y: 0, z: 13 } },
      // Perimeter walls stop at z = 3. Full-height walls are honest physics and
      // a useless picture: from any isometric camera the volume becomes a closed
      // box and the floating bodies inside disappear behind its rim. The planner
      // never leaves the bounds anyway, so a low rim encloses it just as well —
      // and three metres still reads as an enclosure rather than a skirting.
      { kind: 'box3', min: { x: -1, y: -1, z: -1 }, max: { x: 0, y: 23, z: 3 } },
      { kind: 'box3', min: { x: 30, y: -1, z: -1 }, max: { x: 31, y: 23, z: 3 } },
      { kind: 'box3', min: { x: -1, y: -1, z: -1 }, max: { x: 31, y: 0, z: 3 } },
      { kind: 'box3', min: { x: -1, y: 21, z: -1 }, max: { x: 31, y: 22, z: 3 } },
      // No ceiling, and no long beams either. Both were tried: a lid turns the
      // volume into an opaque block, and two full-span beams project into two
      // fat diagonals that cover exactly the space the route climbs through.
      // Thin columns carry the same "this is a volume with height" message
      // without occupying the picture.
      { kind: 'capsule3', a: { x: 4, y: 4, z: 0 }, b: { x: 4, y: 4, z: 11.5 }, r: 0.42 },
      { kind: 'capsule3', a: { x: 26, y: 18, z: 0 }, b: { x: 26, y: 18, z: 11.5 }, r: 0.42 },
      { kind: 'capsule3', a: { x: 11, y: 19, z: 0 }, b: { x: 11, y: 19, z: 8.5 }, r: 0.38 },
      sphere(9, 6, 5, 2.6),
      sphere(20, 16, 7, 3.1),
      sphere(15, 11, 2.4, 1.8),
      { kind: 'capsule3', a: { x: 7, y: 16, z: 0 }, b: { x: 7, y: 16, z: 9 }, r: 1.2 },
      { kind: 'capsule3', a: { x: 24, y: 6, z: 0 }, b: { x: 24, y: 6, z: 8 }, r: 1.4 },
      { kind: 'box3', min: { x: 12, y: 3, z: 8 }, max: { x: 19, y: 9, z: 9 } },
    ],
  }
}

export interface FieldScene {
  key: 'roundHall' | 'floatingGrove'
  space: FieldSpace
  start: Vec3
  goal: Vec3
  /** Lattice resolution used when a graph solver runs on the field. */
  resolution: number
}

const FIELD_CACHE = new Map<FieldScene['key'], FieldScene>()

export function fieldScene(key: FieldScene['key']): FieldScene {
  const cached = FIELD_CACHE.get(key)
  if (cached) return cached
  const scene: FieldScene =
    key === 'roundHall'
      ? {
          key,
          space: roundHall(),
          start: { x: 3, y: 22, z: 0 },
          goal: { x: 33, y: 4, z: 0 },
          resolution: 0.5,
        }
      : {
          key,
          space: floatingGrove(),
          // Both endpoints sit clear of the safety margin. The obvious choices —
          // tucked just under the roof, hugging a wall — are inside the inflation
          // radius, and the scene then opens on "infeasible", which is the wrong
          // first impression for a demo.
          start: { x: 3.5, y: 18.5, z: 3 },
          goal: { x: 26, y: 3.5, z: 8 },
          resolution: 0.6,
        }
  FIELD_CACHE.set(key, scene)
  return scene
}
