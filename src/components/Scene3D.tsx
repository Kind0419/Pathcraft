/**
 * The 3D view.
 *
 * Orthographic, software-rasterised, no three.js. That is a deliberate trade:
 * the release is a single offline HTML file, and pulling in a WebGL engine for
 * axis-aligned cubes and a polyline would cost more than it gives. Everything
 * here is painter's algorithm over precomputed faces — the geometry of a world
 * does not change when the camera moves, so only projection and sorting happen
 * per frame.
 *
 * What it renders, in one place:
 *   - voxel worlds  → exposed cube faces only (interior faces are culled once)
 *   - analytic SDF  → spheres, boxes, capsules, and flat primitives on z = 0
 *   - the result    → search trail, path, start and goal markers
 *
 * The trail and the path are sorted into the same depth list as the walls, so a
 * column really does occlude the route behind it instead of the path being
 * painted on top like a decal.
 *
 * Movement is deliberately not React state. A pointermove during an orbit used
 * to call setYaw, which re-rendered this component, rebuilt every draw closure
 * and re-ran the effect — sixty times a second, to change one number. The camera
 * now lives in a ref and the canvas repaints from a requestAnimationFrame
 * callback, so a drag touches nothing but the canvas. That is also what makes
 * inertia and eased zoom possible: there is a frame loop to hang them on, rather
 * than a React commit per gesture sample.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlanResult } from '../lib/types'
import type { Primitive, Vec3 } from '../lib/core/space'
import type { World } from '../lib/worlds'
import { snapOnLayer } from '../lib/worlds'
import { tr, useLang } from '../lib/i18n'
import { CANVAS, type CanvasPalette, useTheme } from '../lib/theme'
// The camera lives in its own module so `scripts/pick.ts` can round-trip it
// without a canvas. Picking inverts exactly what this draws; one copy of the
// maths is the only way to keep that true.
import {
  Z_LIFT,
  fitView,
  projectIn,
  unprojectIn,
  viewRay,
  type CameraFrame,
} from '../lib/projection'

interface Props {
  world: World
  result: PlanResult | null
  start: Vec3
  goal: Vec3
  playhead: number
  showExpanded: boolean
  showPath: boolean
  pickMode: 'none' | 'start' | 'goal'
  onPick?: (which: 'start' | 'goal', point: Vec3) => void
  /**
   * Ask the parent for a route *without* committing the endpoint.
   *
   * Returns the path for "drag S to here", or null when that position has no
   * answer. Deliberately not a state update: a drag crosses a cell every ~12 px
   * and routing that through React re-rendered the entire workbench per
   * crossing (p95 frame gap 116 ms). The gesture is drawn here; only the drop
   * is committed.
   */
  previewPlan?: (which: 'start' | 'goal', point: Vec3) => Vec3[] | null
}

interface Face {
  /** Four corners in world space, counter-clockwise seen from outside. */
  corners: Vec3[]
  nx: number
  ny: number
  nz: number
  /** Shade index: 0 wall top, 1 side facing +x/+y, 2 side facing -x/-y, 3 floor. */
  shade: 0 | 1 | 2 | 3
  /** Resolved fill. Upward faces get a small lift with altitude. */
  fill: string
}

const TAU = Math.PI * 2

/* ------------------------------------------------------------------ palette */
/*
 * One material, three tones.
 *
 * The volume is a single substance: concrete, clay, whatever the viewer decides.
 * Painting each orientation a separately-chosen colour breaks that — the blocks
 * stop looking like one material lit from one side and start looking like a
 * diagram with a legend. So every wall tone is derived from MATERIAL by value
 * alone, which also means the palette can be re-tinted by editing one hex.
 *
 * The floor is the exception, and it is not decoration. A solid volume is a
 * single material, so the first build gave the ground slab and the wall tops the
 * same colour; the result read as one grey plate with bumps — no floor to stand
 * on, no height to the blocks, nothing for the route to sit *above*. Ground is
 * lighter and warmer than anything standing on it.
 */
/** Blend a hex toward black (factor < 1) or white (factor > 1). */
function toneOf(hex: string, factor: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  if (factor >= 1) {
    const t = Math.min(1, factor - 1)
    return `rgb(${c.map((v) => Math.round(v + (255 - v) * t)).join(', ')})`
  }
  return `rgb(${c.map((v) => Math.round(v * factor)).join(', ')})`
}

/*
 * Four tones, not two. Reading a block in an orthographic view depends on the
 * eye separating "facing up" from "facing away", and one step between those is
 * not enough at this size: the volume collapses into a silhouette. The steps
 * below are deliberately wide (185 → 155 → 99 → 76 in luminance) so every edge
 * is legible without a single outline stroke — outlines on one-metre voxels
 * read as tiling, which is exactly what this view must not look like.
 */
/* Mutable, because the scene has two themes and the draw pass reads them at
 * frame time. `applyPalette` is called once per render from the component; the
 * draw effect depends on the theme, so a switch repaints with the new values. */
let FLOOR = CANVAS.light.floor
let WALL_TOP = CANVAS.light.wallTop
let WALL_SIDE_A = CANVAS.light.wallSideA
let WALL_SIDE_B = CANVAS.light.wallSideB
let WALL_RIM = CANVAS.light.wallRim
let MATERIAL = CANVAS.light.wallSideA

let PAPER_TOP = CANVAS.light.stageTop
let PAPER_MID = CANVAS.light.stageMid
let PAPER_LOW = CANVAS.light.stageLow
let KEY_LIGHT = CANVAS.light.keyLight
let KEY_LIGHT_MID = CANVAS.light.keyLightMid
let PLATE = CANVAS.light.plate
let PLATE_EDGE = CANVAS.light.plateEdge
let SHADOW_TINT = CANVAS.light.shadow
let POOL = CANVAS.light.pool

// The path is the one element that must survive every background: it crosses the
// pale floor, then a wall's top face, then a wall's shaded side. A single flat
// colour cannot do that — pine on the walls goes to near-black. So the route is
// drawn as a light ribbon with a dark underlay, which reads on all three.
let PATH = CANVAS.light.route
let PATH_LOW = CANVAS.light.routeLow
let PATH_HIGH = CANVAS.light.routeHigh
let PATH_HALO = CANVAS.light.routeHalo
let START = CANVAS.light.start
let GOAL = CANVAS.light.goal
let START_GLOW = CANVAS.light.startGlow
let GOAL_GLOW = CANVAS.light.goalGlow
let TRAIL = CANVAS.light.trail.join(', ')
let ROUTE_GLOW = CANVAS.light.routeGlow
/** Dashed plumb line under a dragged marker: says which altitude it is on. */
let MARKER_RING = CANVAS.light.markerStroke
let MARKER_INK = CANVAS.light.markerInk
let MARKER_SHADOW = 'rgba(40, 48, 41, 0.12)'
let GUIDE = CANVAS.light.guide
/** A drop that has no legal cell on its own layer. */
let WARN = CANVAS.light.warn

/**
 * Point every surface at one palette.
 *
 * The 3D pass has thirty-odd colour constants and one draw path. Rather than
 * thread a palette through every closure, the constants are module-level and
 * reassigned here; the draw effect lists `theme` as a dependency, so a switch
 * repaints with the new set. One scene instance exists at a time, so this is
 * safe as well as cheap.
 */
function applyPalette(name: 'light' | 'dark'): void {
  const p = CANVAS[name]
  FLOOR = p.floor
  WALL_TOP = p.wallTop
  WALL_SIDE_A = p.wallSideA
  WALL_SIDE_B = p.wallSideB
  WALL_RIM = p.wallRim
  MATERIAL = p.wallSideA
  PAPER_TOP = p.stageTop
  PAPER_MID = p.stageMid
  PAPER_LOW = p.stageLow
  KEY_LIGHT = p.keyLight
  KEY_LIGHT_MID = p.keyLightMid
  PLATE = p.plate
  PLATE_EDGE = p.plateEdge
  SHADOW_TINT = p.shadow
  POOL = p.pool
  PATH = p.route
  PATH_LOW = p.routeLow
  PATH_HIGH = p.routeHigh
  PATH_HALO = p.routeHalo
  START = p.start
  GOAL = p.goal
  START_GLOW = p.startGlow
  GOAL_GLOW = p.goalGlow
  TRAIL = p.trail.join(', ')
  ROUTE_GLOW = p.routeGlow
  MARKER_RING = p.markerStroke
  MARKER_INK = p.markerInk
  // A paper shadow is invisible on a dark stage and a black one is a smear on
  // paper, so the marker's own drop shadow is the one value that has to be
  // chosen per theme rather than derived.
  MARKER_SHADOW = name === 'dark' ? 'rgba(0, 0, 0, 0.30)' : 'rgba(40, 48, 41, 0.12)'
  GUIDE = p.guide
  WARN = p.warn
}

/** Identity of a lattice cell, for "did the drag cross a cell" checks. */
function cellKey(p: Vec3): string {
  return `${p.x.toFixed(2)}:${p.y.toFixed(2)}:${p.z.toFixed(2)}`
}

const HOME_VIEW = { yaw: -0.66, pitch: 0.86, zoom: 1 }
const PITCH_MIN = 0.16
const PITCH_MAX = 1.42
const ZOOM_MIN = 0.55
const ZOOM_MAX = 3.6

/**
 * How hard the camera chases the hand, in milliseconds.
 *
 * The time constant, not a per-frame fraction: `1 − exp(−dt/τ)` converges in
 * the same wall-clock time at any refresh rate. 52 ms is ~0.27 of the remaining
 * distance per frame at 60 Hz — enough smoothing to swallow a stutter, little
 * enough that the scene still feels attached to the pointer.
 */
const CAM_TAU = 52
/** The drag marker's walk between cells. Slightly slower, so it reads as snap. */
const DRAG_EASE_TAU = 64
/** How far past the pitch limit the hand may push, in radians (~4°). */
const PITCH_GIVE = 0.07
/**
 * The window a release velocity is measured over, in ms.
 *
 * Long enough to average out a dropped pointermove, short enough that a
 * deliberate slow drag registers as slow rather than as a flick.
 */
const FLICK_WINDOW_MS = 90

/**
 * Soft pitch limits.
 *
 * Capped hard at `PITCH_GIVE` past the range rather than proportional: an
 * axonometric projection turns inside out at 90°, so "let it overshoot freely
 * and spring back" would let a fast flick show the scene upside down for a
 * frame. Four degrees is enough to feel like an edge, and far from vertical.
 */
function softPitch(pitch: number) {
  return clamp(pitch, PITCH_MIN - PITCH_GIVE, PITCH_MAX + PITCH_GIVE)
}

/**
 * Keep a pan from walking the scene off the canvas.
 *
 * Panning is only ever a side effect of zooming about the cursor, so it should
 * stay small; this is the backstop for a long wheel session at max zoom, where
 * a few hundred accumulations could otherwise leave an empty canvas.
 */
function clampPan(value: number, extent: number) {
  const limit = extent * 0.55
  return Math.max(-limit, Math.min(limit, value))
}

interface View {
  yaw: number
  pitch: number
  zoom: number
}

/** Linear blend between two `#rrggbb` colours. */
function mix(a: string, b: string, t: number): string {
  const channel = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const ca = channel(a)
  const cb = channel(b)
  const at = (i: number) => Math.round(ca[i] + (cb[i] - ca[i]) * t)
  return `rgb(${at(0)}, ${at(1)}, ${at(2)})`
}

/** `#rrggbb` -> channels, for shading maths that has to stay numeric. */
function rgbTuple(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/**
 * Nudge a projected quad outward by a fraction of a pixel.
 *
 * Adjacent faces share an edge exactly, and canvas antialiasing blends that edge
 * with the background *twice* — once per face — leaving a hairline of the page
 * colour. On a wall it is invisible; on a floor made of twenty strips it reads
 * as a ruled grid. A half-pixel overlap makes the seam disappear without a
 * stroke, and a stroke is worse: at this size it is a visible outline around
 * every quad.
 */
function expandQuad(pts: Array<{ x: number; y: number }>, amount: number) {
  if (pts.length < 3) return pts
  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p.x
    cy += p.y
  }
  cx /= pts.length
  cy /= pts.length
  return pts.map((p) => {
    const dx = p.x - cx
    const dy = p.y - cy
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) return p
    const k = (len + amount) / len
    return { x: cx + dx * k, y: cy + dy * k }
  })
}

/**
 * Exposed faces of a voxel volume, merged along each run.
 *
 * One quad per voxel is the obvious implementation and it is the wrong picture.
 * A 30 x 21 floor is 630 quads; the hairline stroke that hides the seam between
 * two of them adds up to a faint grid over the whole plate, and the scene reads
 * as a tiled diagram rather than a surface. Runs of equal exposure merge into
 * one quad per row, so the floor becomes twenty-odd strips with no internal
 * seam — and an order of magnitude fewer faces to project and sort per frame.
 *
 * Merging along *one* axis only is deliberate. A quad's sort key is its average
 * depth, so the larger the quad, the more that single number lies about its
 * parts: one giant floor plane sorts either in front of the far wall or behind
 * the near one, and in both cases the wall visibly sinks into the ground. A run
 * is the largest shape whose average depth is still honest.
 */
function buildFaces(cells: Uint8Array, width: number, height: number, depth: number): Face[] {
  const faces: Face[] = []
  const plane = width * height
  const solid = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) return true
    return cells[z * plane + y * width + x] === 1
  }

  /** Walk a row, emitting [start, end] for every maximal true run. */
  const runs = (length: number, exposed: (i: number) => boolean, emit: (a: number, b: number) => void) => {
    let i = 0
    while (i < length) {
      if (!exposed(i)) {
        i += 1
        continue
      }
      let j = i
      while (j + 1 < length && exposed(j + 1)) j += 1
      emit(i, j)
      i = j + 1
    }
  }

  // Up and down, one row at a time.
  for (let z = 0; z < depth; z += 1) {
    for (const nz of [1, -1] as const) {
      const zz = nz > 0 ? z + 1 : z
      const shade: 0 | 2 | 3 = nz > 0 ? (z === 0 ? 3 : 0) : 2
      // Upward faces brighten slightly with height. Two slabs at different
      // levels are otherwise the same colour, and in an orthographic view the
      // only thing left to separate them is the thin side band — which reads as
      // one plate with a stripe on it. A 6% lift is under the threshold of
      // "this is lit differently" and over the threshold of "these are two
      // floors".
      const fill =
        // No altitude tint any more: the palette gives the top its own value and
        // the side faces carry a vertical light falloff, so levels separate without
        // a second derived colour that the palettes cannot express.
        shade === 3 ? FLOOR : shade === 0 ? WALL_TOP : WALL_SIDE_B
      for (let y = 0; y < height; y += 1) {
        runs(
          width,
          (x) => solid(x, y, z) && !solid(x, y, z + nz),
          (x0, x1) => {
            faces.push({
              corners: [
                { x: x0, y, z: zz },
                { x: x1 + 1, y, z: zz },
                { x: x1 + 1, y: y + 1, z: zz },
                { x: x0, y: y + 1, z: zz },
              ],
              nx: 0,
              ny: 0,
              nz,
              shade,
              fill,
            })
          },
        )
      }
    }
  }

  // East and west, one column of the (y, z) plane at a time.
  for (let x = 0; x < width; x += 1) {
    for (const nx of [1, -1] as const) {
      const xx = nx > 0 ? x + 1 : x
      for (let z = 0; z < depth; z += 1) {
        runs(
          height,
          (y) => solid(x, y, z) && !solid(x + nx, y, z),
          (y0, y1) => {
            faces.push({
              corners: [
                { x: xx, y: y0, z },
                { x: xx, y: y1 + 1, z },
                { x: xx, y: y1 + 1, z: z + 1 },
                { x: xx, y: y0, z: z + 1 },
              ],
              nx,
              ny: 0,
              nz: 0,
              shade: nx > 0 ? 1 : 2,
              fill: nx > 0 ? WALL_SIDE_A : WALL_SIDE_B,
            })
          },
        )
      }
    }
  }

  // North and south, one column of the (x, z) plane at a time.
  for (let y = 0; y < height; y += 1) {
    for (const ny of [1, -1] as const) {
      const yy = ny > 0 ? y + 1 : y
      for (let z = 0; z < depth; z += 1) {
        runs(
          width,
          (x) => solid(x, y, z) && !solid(x, y + ny, z),
          (x0, x1) => {
            faces.push({
              corners: [
                { x: x0, y: yy, z },
                { x: x1 + 1, y: yy, z },
                { x: x1 + 1, y: yy, z: z + 1 },
                { x: x0, y: yy, z: z + 1 },
              ],
              nx: 0,
              ny,
              nz: 0,
              shade: ny > 0 ? 1 : 2,
              fill: ny > 0 ? WALL_SIDE_A : WALL_SIDE_B,
            })
          },
        )
      }
    }
  }

  return faces
}

/** One place that knows what each face orientation looks like. */
function shadeFill(shade: 0 | 1 | 2 | 3): string {
  if (shade === 3) return FLOOR
  if (shade === 0) return WALL_TOP
  return shade === 1 ? WALL_SIDE_A : WALL_SIDE_B
}

interface DrawItem {
  depth: number
  draw: (ctx: CanvasRenderingContext2D) => void
}

export function Scene3D({
  world,
  result,
  start,
  goal,
  playhead,
  showExpanded,
  showPath,
  pickMode,
  onPick,
  previewPlan,
}: Props) {
  const lang = useLang()
  const theme = useTheme()
  // The palette has to be installed before the draw effect runs, and the effect
  // lists `theme` so a switch repaints. useMemo keeps it ordered with render.
  useMemo(() => applyPalette(theme), [theme])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  /** Last painted viewport, for the frame loop. A ref, not `size`: the loop runs
   *  inside a closure that must not go stale on resize. */
  const viewportRef = useRef({ width: 0, height: 0 })

  /* ------------------------------------------------------------- camera --- */
  // Authoritative in refs: dragging must not re-render React.
  //
  // Two views of the same camera. `target` is what the hand asked for; `view`
  // is what the picture is drawn with, and it chases the target with a time
  // constant. The orbit used to write `view` directly, one pointer sample at a
  // time — so a jittery input became a jittery scene, and a dropped sample
  // became a visible lurch. Easing through a target absorbs both, and it costs
  // nothing: the frame loop already exists for zoom.
  const viewRef = useRef<View>({ ...HOME_VIEW })
  const targetRef = useRef<View>({ ...HOME_VIEW })
  /** Coast velocity, radians per second. Only spins up on a flick. */
  const spinRef = useRef({ yaw: 0, pitch: 0 })
  /** Screen-space nudge from zooming toward the cursor instead of the centre. */
  const panRef = useRef({ x: 0, y: 0 })
  /** The world point under the pointer when the wheel turned. Held still. */
  const zoomAnchorRef = useRef<{ x: number; y: number; world: Vec3 } | null>(null)
  /** Recent pointer samples, for a velocity that survives a dropped event. */
  const trailRef = useRef<Array<{ t: number; x: number; y: number }>>([])
  const homeRef = useRef(false)

  /* -------------------------------------------------------- interaction --- */
  // A drag has two positions, and they are not the same thing.
  //
  //   finger — where the hand is, unsnapped
  //   anchor — the legal cell the planner will actually use, and the only
  //            thing the marker is ever drawn on
  //
  // The 2D canvas makes the same split: dragging over a wall slides the
  // endpoint to the nearest legal cell instead of stopping dead. In 3D the
  // marker used to follow the *finger* while the drop used the *anchor*, so
  // the two disagreed by however far the snap had to reach — which reads as
  // "I put it here and it went there". Drawing the marker on the anchor fixes
  // that by construction: the picture and the result are the same object. The
  // finger keeps a thin dashed tie, so when it has been pushed away from a
  // wall you can see by how much.
  //
  // A commit costs a search (45–56 ms in a voxel world), so it is budgeted:
  // only when the anchor cell changes, never more than once per DRAG_PLAN_MS,
  // and the state update is queued behind a paint so the marker moves first.
  const DRAG_PLAN_MS = 90
  /** How far an anchor may slide out from under the finger, in cells. */
  /**
   * How far a dragged point may slide to stay legal, in cells.
   *
   * Three was too generous: dragging across a column could jump the marker to
   * the far side, which reads as "it teleported". Two keeps the point on the
   * wall face the hand is on; the arrow keys cover the rest (perspective can
   * never be precise to a cell, so the keyboard is the honest fallback).
   */
  const SLIDE_CELLS = 2
  const ghostRef = useRef<{
    which: 'start' | 'goal'
    /** The unsnapped point under the finger. Drawn as a hint, never as the marker. */
    point: Vec3
    /** The legal cell the drag currently resolves to — where the marker is drawn. */
    anchor: Vec3
    /** The finger is over something the anchor had to slide away from. */
    sliding: boolean
  } | null>(null)
  /**
   * The marker's eased position, in world space.
   *
   * A cell-snapped marker jumps a cell at a time, and a jumped control reads as
   * a dropped input rather than a snapped one. This chases `ghost.anchor` in
   * the frame loop, so the marker *walks* to the cell it will land in — and
   * arrives before the route does.
   */
  const dragEaseRef = useRef<Vec3 | null>(null)
  const hoverRef = useRef<'start' | 'goal' | null>(null)
  const dragRef = useRef<{
    mode: 'orbit' | 'start' | 'goal'
    x: number
    y: number
    yaw: number
    pitch: number
    lastX: number
    lastY: number
    lastT: number
    /** Screen pixels travelled so far — decides click vs drag. */
    moved: number
    pick: 'none' | 'start' | 'goal'
    /** Altitude held constant for the whole gesture. See `snapOnLayer`. */
    planeZ: number
    /** Last legal cell — the fallback when the finger is over nothing legal. */
    anchor: Vec3
    /** Last anchor the planner could actually route from, for the drop. */
    goodAnchor: Vec3
    /** Last cell pushed to the planner, so a move inside one cell is free. */
    lastKey: string
    lastEmit: number
    /**
     * World-space gap between the hand and the marker at the moment of the grab.
     * Re-applied every move so the point travels *with* the hand instead of
     * snapping underneath it.
     */
    grabOffset: { x: number; y: number }
  } | null>(null)
  /** Which endpoint the arrow keys nudge: the last one the hand grabbed. */
  const lastGrabRef = useRef<'start' | 'goal'>('start')
  /** Queued commit: the newest anchor waiting for the next paint. */
  const commitRef = useRef<{ which: 'start' | 'goal'; point: Vec3; handle: number } | null>(null)
  /** Route for the current drag position. `null` path means "no answer here". */
  const previewRef = useRef<{ path: Vec3[] | null } | null>(null)
  /** The exact transform the last frame was drawn with, reused for hit-testing. */
  const frameRef = useRef<CameraFrame | null>(null)

  /* --------------------------------------------------------- scheduling --- */
  const drawRef = useRef<() => void>(() => {})
  const rafRef = useRef<number | null>(null)
  const animRef = useRef<number | null>(null)

  const geometry = useMemo(() => {
    if (world.kind === 'grid2d') {
      // Rendered only for non-grid worlds; keep the hook total anyway.
      return {
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
        faces: [] as Face[],
        primitives: [] as Primitive[],
        dim: 2 as const,
        pickZ: 0,
      }
    }
    if (world.kind === 'voxel3d') {
      const v = world.scene.volume
      return {
        bounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: v.width * v.spacing, y: v.height * v.spacing, z: v.depth * v.spacing },
        },
        faces: buildFaces(v.cells, v.width, v.height, v.depth),
        primitives: [] as Primitive[],
        dim: 3 as const,
        // The volume's ground layer is solid, so the lowest layer a path can
        // occupy is the one above it. Endpoints are placed on *that* plane: an
        // endpoint dropped on z = 0 would first be lifted a whole voxel, and at
        // ~19 px per metre that lift lands the marker 19 px above the cursor —
        // which reads as "I clicked here and it went somewhere else".
        pickZ: v.spacing,
      }
    }
    const space = world.scene.space
    return {
      bounds: space.bounds,
      faces: [] as Face[],
      primitives: space.primitives,
      dim: space.dim,
      pickZ: space.bounds.min.z,
    }
    // `theme` belongs here: buildFaces bakes each face's resolved fill, so a
    // theme switch has to rebuild the geometry or the walls keep the old
    // palette while the backdrop changes under them.
  }, [world, theme])

  /**
   * One entry per occupied column, for the contact shadows.
   *
   * Without a shadow a column is a shape with no relationship to the ground: on
   * a pale floor it hovers. A full shadow map would be a blur pass per frame, so
   * this keeps only what the eye needs — how tall each column is — and lets the
   * renderer turn that into one soft smudge per column in a single fill call.
   */
  const columns = useMemo(() => {
    if (world.kind !== 'voxel3d') return [] as Array<{ x: number; y: number; h: number }>
    const v = world.scene.volume
    const plane = v.width * v.height
    const out: Array<{ x: number; y: number; h: number }> = []
    for (let y = 0; y < v.height; y += 1) {
      for (let x = 0; x < v.width; x += 1) {
        let top = -1
        for (let z = v.depth - 1; z >= 1; z -= 1) {
          if (v.cells[z * plane + y * v.width + x] === 1) {
            top = z
            break
          }
        }
        if (top >= 1) out.push({ x: (x + 0.5) * v.spacing, y: (y + 0.5) * v.spacing, h: (top + 1) * v.spacing })
      }
    }
    return out
  }, [world])

  /**
   * The search trail, deduplicated once per result.
   *
   * The search expands *states*, not voxels: a cell is reached once per incoming
   * direction, so the event list holds up to 27 entries per voxel. Plotting them
   * all repaints the same cell again and again and the volume turns into a solid
   * dark carpet. Collapsing to one mark per cell, ordered by first touch, is what
   * makes it read as "the volume the search swept".
   *
   * Done here rather than per frame: the dedupe is a Map over up to thirty
   * thousand events, which is fine once and not fine sixty times a second.
   */
  const trail = useMemo(() => {
    if (!result) return [] as Array<{ x: number; y: number; z: number; order: number; phase: number }>
    const seen = new Map<number, number>()
    const total = result.events.length
    for (let i = 0; i < total; i += 1) {
      const event = result.events[i]
      const key =
        (Math.round(event.x * 2) * 256 + Math.round(event.y * 2)) * 256 + Math.round((event.z ?? 0) * 2)
      if (!seen.has(key)) seen.set(key, i)
    }
    return [...seen.values()].map((i) => {
      const event = result.events[i]
      return { x: event.x, y: event.y, z: event.z ?? 0, order: i, phase: Math.min(1, (i + 1) / Math.max(1, total)) }
    })
  }, [result])

  /** Altitude range of the route, used for the height tint. */
  const altitude = useMemo(() => {
    const path = result?.path3
    if (!path || path.length === 0) return { low: 0, span: 1 }
    let low = Infinity
    let high = -Infinity
    for (const p of path) {
      if (p.z < low) low = p.z
      if (p.z > high) high = p.z
    }
    return { low, span: Math.max(1e-6, high - low) }
  }, [result])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setSize({ width: box.width, height: box.height })
    })
    observer.observe(host)
    setSize({ width: host.clientWidth, height: host.clientHeight })
    return () => observer.disconnect()
  }, [])

  /** Coalesce every request in a frame into one paint. */
  const schedulePaint = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      drawRef.current()
    })
  }, [])

  /**
   * The frame loop: eased orbit, eased zoom, coast, the home tween, and the
   * drag marker's walk to its cell.
   *
   * One loop for all of them because they are the same problem — a value that
   * should approach a target instead of jumping to it. Every step is scaled by
   * `dt`, so the feel does not change with the refresh rate: a 30 Hz laptop and
   * a 144 Hz monitor converge in the same wall-clock time. The old loop moved a
   * fixed fraction of the remaining distance per frame, which is why inertia
   * felt different on different machines and why a dropped frame read as a
   * lurch.
   *
   * It parks itself as soon as everything has settled, so an idle canvas costs
   * nothing.
   */
  const ensureAnimation = useCallback(() => {
    if (animRef.current != null) return
    let last = performance.now()
    const frame = (now: number) => {
      // Clamped: a backgrounded tab comes back with a multi-second gap, and a
      // dt that large would teleport the camera instead of easing it.
      const dt = Math.min(64, Math.max(8, now - last))
      last = now
      const view = viewRef.current
      const target = targetRef.current
      const ease = (tau: number) => 1 - Math.exp(-dt / tau)
      let busy = false

      // --- coast ---------------------------------------------------------
      const spin = spinRef.current
      if (Math.abs(spin.yaw) > 0.02 || Math.abs(spin.pitch) > 0.02) {
        target.yaw += (spin.yaw * dt) / 1000
        target.pitch = softPitch(target.pitch + (spin.pitch * dt) / 1000)
        // Per-second decay, so a flick coasts the same distance regardless of
        // frame rate. 0.06 keeps 6% after a second: a clear stop, not a glide.
        const damp = Math.pow(0.06, dt / 1000)
        spin.yaw *= damp
        spin.pitch *= damp
        busy = true
      } else if (spin.yaw !== 0 || spin.pitch !== 0) {
        spin.yaw = 0
        spin.pitch = 0
        busy = true
      }

      // --- pitch limits ---------------------------------------------------
      // The edge gives 4° while the hand is on it, then takes it back. A hard
      // stop at the limit is what made the drag feel like it had snagged.
      if (dragRef.current?.mode !== 'orbit' && !homeRef.current) {
        const settledPitch = clamp(target.pitch, PITCH_MIN, PITCH_MAX)
        if (Math.abs(settledPitch - target.pitch) > 1e-4) {
          target.pitch += (settledPitch - target.pitch) * ease(150)
          busy = true
        } else {
          target.pitch = settledPitch
        }
      }

      // --- home -----------------------------------------------------------
      if (homeRef.current) {
        // Shortest way round: after a few orbits yaw may be at +9 rad, and
        // tweening to −0.66 the naive way spins the scene twice.
        target.yaw = HOME_VIEW.yaw + TAU * Math.round((view.yaw - HOME_VIEW.yaw) / TAU)
        target.pitch = HOME_VIEW.pitch
        target.zoom = HOME_VIEW.zoom
        panRef.current.x += (0 - panRef.current.x) * ease(170)
        panRef.current.y += (0 - panRef.current.y) * ease(170)
        const settled =
          Math.abs(target.yaw - view.yaw) < 0.004 &&
          Math.abs(target.pitch - view.pitch) < 0.004 &&
          Math.abs(target.zoom - view.zoom) < 0.006 &&
          Math.abs(panRef.current.x) < 0.6 &&
          Math.abs(panRef.current.y) < 0.6
        if (settled) {
          view.yaw = HOME_VIEW.yaw
          view.pitch = HOME_VIEW.pitch
          view.zoom = HOME_VIEW.zoom
          target.yaw = HOME_VIEW.yaw
          target.pitch = HOME_VIEW.pitch
          target.zoom = HOME_VIEW.zoom
          panRef.current.x = 0
          panRef.current.y = 0
          zoomAnchorRef.current = null
          homeRef.current = false
        } else {
          busy = true
        }
      }

      // --- chase ----------------------------------------------------------
      const dyaw = target.yaw - view.yaw
      if (Math.abs(dyaw) > 1e-4) {
        view.yaw += dyaw * ease(CAM_TAU)
        busy = true
      } else {
        view.yaw = target.yaw
      }
      const dpitch = target.pitch - view.pitch
      if (Math.abs(dpitch) > 1e-4) {
        view.pitch += dpitch * ease(CAM_TAU)
        busy = true
      } else {
        view.pitch = target.pitch
      }
      const dzoom = target.zoom - view.zoom
      if (Math.abs(dzoom) > 1e-4) {
        view.zoom += dzoom * ease(CAM_TAU)
        busy = true
      } else {
        view.zoom = target.zoom
      }

      // --- hold the pixel under the wheel ---------------------------------
      // Zooming about the cursor is a pan as well as a scale. `pan` is a plain
      // screen translation, so one correction per frame is exact — there is no
      // converging to do. Released once the zoom has settled, otherwise every
      // later orbit would drag the anchor along with it.
      const anchor = zoomAnchorRef.current
      const vp = viewportRef.current
      if (anchor && vp.width > 2 && vp.height > 2) {
        const fitted = fitView(
          geometry.bounds,
          vp.width,
          vp.height,
          view.yaw,
          view.pitch,
          view.zoom,
          panRef.current.x,
          panRef.current.y,
        )
        const at = projectIn(fitted, anchor.world)
        const dx = anchor.x - at.x
        const dy = anchor.y - at.y
        if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) {
          const wantX = panRef.current.x + dx
          const wantY = panRef.current.y + dy
          const nextX = clampPan(wantX, vp.width)
          const nextY = clampPan(wantY, vp.height)
          // A clamped pan cannot hold the point, and insisting would keep this
          // loop awake forever chasing a correction it is not allowed to make.
          // Give the anchor up instead: the zoom continues, the pivot does not.
          if (Math.abs(nextX - wantX) > 0.5 || Math.abs(nextY - wantY) > 0.5) {
            zoomAnchorRef.current = null
          } else {
            panRef.current.x = nextX
            panRef.current.y = nextY
            busy = true
          }
        }
        if (Math.abs(target.zoom - view.zoom) < 1e-3) zoomAnchorRef.current = null
      }

      // --- the drag marker's walk -----------------------------------------
      const ghost = ghostRef.current
      if (ghost) {
        const at = dragEaseRef.current
        if (!at) {
          dragEaseRef.current = { ...ghost.anchor }
        } else {
          const gap = Math.hypot(
            ghost.anchor.x - at.x,
            ghost.anchor.y - at.y,
            ghost.anchor.z - at.z,
          )
          if (gap > 0.004) {
            const k = ease(DRAG_EASE_TAU)
            at.x += (ghost.anchor.x - at.x) * k
            at.y += (ghost.anchor.y - at.y) * k
            at.z += (ghost.anchor.z - at.z) * k
            busy = true
          } else {
            at.x = ghost.anchor.x
            at.y = ghost.anchor.y
            at.z = ghost.anchor.z
          }
        }
      }

      schedulePaint()
      animRef.current = busy ? requestAnimationFrame(frame) : null
    }
    animRef.current = requestAnimationFrame(frame)
  }, [geometry, schedulePaint])

  useEffect(
    () => () => {
      // Clearing the handles matters as much as cancelling: StrictMode mounts,
      // unmounts and remounts this component, and a stale non-null id would make
      // schedulePaint believe a frame was already queued when it had just been
      // cancelled — the canvas then stays blank until the next prop change.
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (animRef.current != null) {
        cancelAnimationFrame(animRef.current)
        animRef.current = null
      }
    },
    [],
  )

  /* ------------------------------------------------------------- paint --- */
  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width < 2 || size.height < 2) return

    const width = size.width
    const height = size.height
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const pixelWidth = Math.round(width * dpr)
    const pixelHeight = Math.round(height * dpr)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const view = viewRef.current
    const bounds = geometry.bounds
    viewportRef.current = { width, height }
    const pan = panRef.current
    const frame = fitView(bounds, width, height, view.yaw, view.pitch, view.zoom, pan.x, pan.y)
    // Remembered so pointer maths uses the frame that is actually on screen.
    frameRef.current = frame
    const { scale } = frame
    const projectPoint = (p: Vec3) => projectIn(frame, p)
    const floorZ = bounds.min.z

    /* The scene's own footprint on screen, padded. Used to keep the search
       stipple inside the picture: a 3D expansion high above the volume projects
       outside its silhouette, and those strays read as dust on the lens rather
       than as part of the search. */
    let clipX0 = Infinity
    let clipX1 = -Infinity
    let clipY0 = Infinity
    let clipY1 = -Infinity
    for (let i = 0; i < 8; i += 1) {
      const corner = projectPoint({
        x: i & 1 ? bounds.max.x : bounds.min.x,
        y: i & 2 ? bounds.max.y : bounds.min.y,
        z: i & 4 ? bounds.max.z : bounds.min.z,
      })
      if (corner.x < clipX0) clipX0 = corner.x
      if (corner.x > clipX1) clipX1 = corner.x
      if (corner.y < clipY0) clipY0 = corner.y
      if (corner.y > clipY1) clipY1 = corner.y
    }
    clipX0 -= 10
    clipX1 += 10
    clipY0 -= 10
    clipY1 += 10

    /* Background. A flat fill reads as paper; a gradient with one soft light
       reads as a lit surface, and that is most of the difference between "a
       diagram" and "a scene". Costs two fills. */
    const back = ctx.createLinearGradient(0, 0, 0, height)
    back.addColorStop(0, PAPER_TOP)
    back.addColorStop(0.62, PAPER_MID)
    back.addColorStop(1, PAPER_LOW)
    ctx.fillStyle = back
    ctx.fillRect(0, 0, width, height)

    const key = ctx.createRadialGradient(width * 0.42, height * 0.26, 0, width * 0.42, height * 0.26, Math.max(width, height) * 0.72)
    // Warm key, not white: a white wash over a dark room turns the set into fog.
    // The lamp colour lives in the palette so each theme lights with its own source.
    key.addColorStop(0, KEY_LIGHT)
    key.addColorStop(0.55, KEY_LIGHT_MID)
    key.addColorStop(1, 'rgba(255, 214, 160, 0)')
    ctx.fillStyle = key
    ctx.fillRect(0, 0, width, height)

    const items: DrawItem[] = []

    /* Ground plate. Slightly larger than the world so the scene sits *on*
       something rather than floating in the page. Under a voxel floor it is
       covered by the floor faces and only shows as a thin rim. */
    const pad = 0.9
    const plate = [
      { x: bounds.min.x - pad, y: bounds.min.y - pad, z: floorZ },
      { x: bounds.max.x + pad, y: bounds.min.y - pad, z: floorZ },
      { x: bounds.max.x + pad, y: bounds.max.y + pad, z: floorZ },
      { x: bounds.min.x - pad, y: bounds.max.y + pad, z: floorZ },
    ].map(projectPoint)
    items.push({
      // Furthest possible: the plate is the backmost thing in the scene.
      depth: Number.MAX_SAFE_INTEGER,
      draw: (c) => {
        c.beginPath()
        c.moveTo(plate[0].x, plate[0].y)
        for (let i = 1; i < plate.length; i += 1) c.lineTo(plate[i].x, plate[i].y)
        c.closePath()
        c.fillStyle = PLATE
        c.fill()
        c.strokeStyle = PLATE_EDGE
        c.lineWidth = 1
        c.stroke()
      },
    })

    /* Pool of light.
     *
     * A dark stage needs somewhere for the eye to land. One soft radial ellipse
     * on the floor, drawn just above the plate and below everything standing on
     * it, reads as a lamp over the model -- which is the whole difference between
     * "a dark render" and "a lit room". */
    {
      const mid = projectPoint({
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
        z: floorZ,
      })
      const rx = (bounds.max.x - bounds.min.x) * scale * 0.52
      const ry = rx * frame.sp
      items.push({
        depth: Number.MAX_SAFE_INTEGER - 1,
        draw: (c) => {
          const g = c.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, Math.max(rx, ry))
          g.addColorStop(0, POOL)
          g.addColorStop(1, 'rgba(255, 214, 160, 0)')
          c.save()
          c.translate(mid.x, mid.y)
          c.scale(1, Math.max(0.15, ry / Math.max(1, rx)))
          c.translate(-mid.x, -mid.y)
          c.fillStyle = g
          c.beginPath()
          c.arc(mid.x, mid.y, Math.max(rx, ry), 0, TAU)
          c.fill()
          c.restore()
        },
      })
    }

    /* Ground grid. Drawn as items (not as a backdrop pass) so it lands on the
       floor and is still occluded by the walls standing on that floor — a
       backdrop pass draws the grid *through* every block. */
    if (scale > 3) {
      const step = scale > 26 ? 2 : 5
      const drawGrid = (major: boolean) => (c: CanvasRenderingContext2D) => {
        c.strokeStyle = major ? 'rgba(74, 84, 72, 0.13)' : 'rgba(74, 84, 72, 0.07)'
        c.lineWidth = 1
        c.beginPath()
        for (let x = Math.ceil(bounds.min.x / step) * step; x <= bounds.max.x; x += step) {
          if ((Math.abs(x % (step * 2)) < 1e-6) !== major) continue
          const a = projectPoint({ x, y: bounds.min.y, z: floorZ })
          const b = projectPoint({ x, y: bounds.max.y, z: floorZ })
          c.moveTo(a.x, a.y)
          c.lineTo(b.x, b.y)
        }
        for (let y = Math.ceil(bounds.min.y / step) * step; y <= bounds.max.y; y += step) {
          if ((Math.abs(y % (step * 2)) < 1e-6) !== major) continue
          const a = projectPoint({ x: bounds.min.x, y, z: floorZ })
          const b = projectPoint({ x: bounds.max.x, y, z: floorZ })
          c.moveTo(a.x, a.y)
          c.lineTo(b.x, b.y)
        }
        c.stroke()
      }
      const centre = projectPoint({
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
        z: floorZ,
      })
      // A hair nearer than the floor so it paints on top of it, and far enough
      // back that every wall still covers the part running behind it.
      const depth = centre.depth - 0.02
      items.push({ depth, draw: drawGrid(false) })
      items.push({ depth: depth - 0.001, draw: drawGrid(true) })
    }

    /* Contact shadows: one batch, one fill. */
    if (columns.length > 0) {
      const centre = projectPoint({ x: 0, y: 0, z: floorZ })
      items.push({
        depth: centre.depth - 0.015,
        draw: (c) => {
          c.fillStyle = SHADOW_TINT
          c.beginPath()
          for (const col of columns) {
            const p = projectPoint({ x: col.x, y: col.y, z: floorZ })
            const grow = Math.min(1, col.h / 8)
            const rx = Math.max(1.2, scale * (0.34 + grow * 0.26))
            c.moveTo(p.x + rx + 4, p.y + 4)
            c.ellipse(p.x + 4, p.y + 4, rx, rx * 0.55, 0, 0, TAU)
          }
          c.fill()
        },
      })
    }

    /* Analytic bodies cast the same kind of shadow. There is a handful of them,
       so this is a few shapes rather than a shadow map — and it is the cue that
       separates "a ball floating in a box" from "a ball in a room". Bodies that
       already sit on the floor are skipped: their shadow would just be a ring of
       dirt around their own base. */
    {
      type Shadow =
        | { kind: 'ellipse'; x: number; y: number; rx: number; ry: number }
        | { kind: 'quad'; pts: Array<{ x: number; y: number }> }
      const shadows: Shadow[] = []
      for (const primitive of geometry.primitives) {
        if (primitive.kind === 'sphere') {
          if (primitive.z - primitive.r < floorZ + 0.4) continue
          const p = projectPoint({ x: primitive.x, y: primitive.y, z: floorZ })
          const r = primitive.r * scale
          shadows.push({ kind: 'ellipse', x: p.x + 4, y: p.y + 4, rx: r * 0.92, ry: Math.max(1, r * 0.46) })
          continue
        }
        if (primitive.kind === 'box3') {
          const { min, max } = primitive
          if (min.z < floorZ + 0.4) continue
          shadows.push({
            kind: 'quad',
            pts: [
              projectPoint({ x: min.x, y: min.y, z: floorZ }),
              projectPoint({ x: max.x, y: min.y, z: floorZ }),
              projectPoint({ x: max.x, y: max.y, z: floorZ }),
              projectPoint({ x: min.x, y: max.y, z: floorZ }),
            ],
          })
        }
      }
      if (shadows.length > 0) {
        const centre = projectPoint({ x: 0, y: 0, z: floorZ })
        items.push({
          depth: centre.depth - 0.014,
          draw: (c) => {
            c.fillStyle = SHADOW_TINT
            for (const shadow of shadows) {
              c.beginPath()
              if (shadow.kind === 'ellipse') {
                c.ellipse(shadow.x, shadow.y, shadow.rx, shadow.ry, 0, 0, TAU)
              } else {
                c.moveTo(shadow.pts[0].x, shadow.pts[0].y)
                for (let i = 1; i < shadow.pts.length; i += 1) c.lineTo(shadow.pts[i].x, shadow.pts[i].y)
                c.closePath()
              }
              c.fill()
            }
          },
        })
      }
    }

    /* Voxel walls: only faces turned toward the camera. */
    const towardCamera = { x: frame.sy * frame.cp, y: -frame.cy * frame.cp, z: frame.sp }

    /* The wall material.
     *
     * Flat fill was the tell. `wallSideA` is one value, so every side face in the
     * scene was the same colour whatever its height, and a voxel room read as
     * painted cardboard -- no surface, no weight, no contact with the floor.
     *
     * What a side face needs is the value at *z*, not at the face: bright at the
     * top edge where the key grazes it, falling off down the wall, and dropping
     * hard in the last half cell where the floor stops bouncing anything. That
     * is one function, so two stacked faces evaluate to the same colour where
     * they meet and the wall reads as one surface -- which is exactly what went
     * wrong the first time this was tried with a gradient per face: the ramp
     * restarted inside every voxel level and the wall came out striped like a
     * ladder. Here each face carries only the *slice* of the ramp it covers.
     */
    const zTop = Math.max(2, bounds.max.z)
    const toneCache = new Map<number, string>()
    const wallAt = (shade: 1 | 2, z: number): string => {
      const h = clamp(z, 0, zTop)
      const key = Math.round(shade * 1000 + h * 8)
      const hit = toneCache.get(key)
      if (hit) return hit
      const base = rgbTuple(shade === 1 ? WALL_SIDE_A : WALL_SIDE_B)
      const lit = rgbTuple(WALL_TOP)
      const lift = 0.92 * Math.pow(h / zTop, 0.68)
      // Contact shadow: strongest at the floor, gone by the second cell.
      const ao = 0.56 * Math.exp(-h / 1.25)
      const css = `rgb(${base
        .map((v, i) => Math.round(clamp((v + (lit[i] - v) * lift) * (1 - ao), 0, 255)))
        .join(', ')})`
      toneCache.set(key, css)
      return css
    }

    for (const face of geometry.faces) {
      const dot = face.nx * towardCamera.x + face.ny * towardCamera.y + face.nz * towardCamera.z
      if (dot <= 0.001) continue
      const raw = face.corners.map(projectPoint)
      let depth = 0
      for (const p of raw) depth += p.depth
      depth /= raw.length
      const pts = expandQuad(raw, 0.4)
      const vertical = face.nz === 0 && face.shade !== 3
      // Span of the face along z -- the axis the ramp runs down.
      let z0 = face.corners[0].z
      let z1 = z0
      for (const corner of face.corners) {
        if (corner.z < z0) z0 = corner.z
        if (corner.z > z1) z1 = corner.z
      }
      const fill = face.fill
      const lo = vertical ? wallAt(face.shade as 1 | 2, z0) : fill
      const hi = vertical ? wallAt(face.shade as 1 | 2, z1) : fill
      // Anchor the ramp at the middle of the face's lower edge. Only z differs
      // between the two anchors, so the gradient axis is world-vertical on
      // screen -- the direction the light actually falls.
      const midX = (face.corners[0].x + face.corners[1].x) / 2
      const midY = (face.corners[0].y + face.corners[1].y) / 2
      const pLo = vertical ? projectPoint({ x: midX, y: midY, z: z0 }) : null
      const pHi = vertical ? projectPoint({ x: midX, y: midY, z: z1 }) : null
      items.push({
        depth,
        draw: (c) => {
          let paint: string | CanvasGradient = fill
          if (vertical && pLo && pHi && z1 - z0 > 0.01 && Math.abs(pHi.y - pLo.y) > 2) {
            const ramp = c.createLinearGradient(pLo.x, pLo.y, pHi.x, pHi.y)
            ramp.addColorStop(0, lo)
            ramp.addColorStop(1, hi)
            paint = ramp
          } else if (vertical) {
            paint = lo
          }
          c.fillStyle = paint
          c.strokeStyle = paint
          c.lineWidth = 2.6
          c.beginPath()
          c.moveTo(pts[0].x, pts[0].y)
          for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i].x, pts[i].y)
          c.closePath()
          c.fill()
          // The stroke is not decoration: two faces share an edge exactly, and
          // canvas blends that edge with whatever is underneath *once per face*,
          // leaving a hairline of page colour. On a wall it is invisible; on a
          // floor of twenty strips it reads as ruled lines.
          c.stroke()
          // The turn-over at the top of a wall. One thin line is the difference
          // between a column and a silhouette: it is the edge the key grazes,
          // and the only place in the scene where the light reads as a line
          // rather than as a value. Skipped on faces too short to hold it --
          // below about six pixels it is a smudge, not an edge.
          if (vertical) {
            const hgt = Math.hypot(pts[2].x - pts[3].x, pts[2].y - pts[3].y)
            if (hgt > 7) {
              c.strokeStyle = WALL_RIM
              c.lineWidth = 1.3
              c.beginPath()
              c.moveTo(pts[3].x, pts[3].y)
              c.lineTo(pts[2].x, pts[2].y)
              c.stroke()
            }
          }
        },
      })
    }

    /* Analytic primitives. */
    for (const primitive of geometry.primitives) {
      if (primitive.kind === 'disc') {
        const c0 = projectPoint({ x: primitive.x, y: primitive.y, z: floorZ })
        const r = primitive.r * scale
        items.push({
          depth: c0.depth,
          draw: (c) => {
            // A disc on the ground plane is an ellipse once tilted.
            c.fillStyle = WALL_SIDE_A
            c.beginPath()
            c.ellipse(c0.x, c0.y, r, Math.max(1, r * frame.sp), 0, 0, TAU)
            c.fill()
            c.strokeStyle = WALL_SIDE_B
            c.lineWidth = 1
            c.stroke()
          },
        })
        continue
      }
      if (primitive.kind === 'box' && geometry.dim === 2) {
        const pts = [
          projectPoint({ x: primitive.x0, y: primitive.y0, z: floorZ }),
          projectPoint({ x: primitive.x1, y: primitive.y0, z: floorZ }),
          projectPoint({ x: primitive.x1, y: primitive.y1, z: floorZ }),
          projectPoint({ x: primitive.x0, y: primitive.y1, z: floorZ }),
        ]
        let depth = 0
        for (const p of pts) depth += p.depth
        items.push({
          depth: depth / 4,
          draw: (c) => {
            c.fillStyle = WALL_SIDE_A
            c.beginPath()
            c.moveTo(pts[0].x, pts[0].y)
            for (let i = 1; i < 4; i += 1) c.lineTo(pts[i].x, pts[i].y)
            c.closePath()
            c.fill()
          },
        })
        continue
      }
      if (primitive.kind === 'capsule' && geometry.dim === 2) {
        const a = projectPoint({ x: primitive.ax, y: primitive.ay, z: floorZ })
        const b = projectPoint({ x: primitive.bx, y: primitive.by, z: floorZ })
        const w = Math.max(1, primitive.r * 2 * scale * frame.sp)
        items.push({
          depth: (a.depth + b.depth) / 2,
          draw: (c) => {
            c.strokeStyle = WALL_SIDE_A
            c.lineWidth = w
            c.lineCap = 'round'
            c.beginPath()
            c.moveTo(a.x, a.y)
            c.lineTo(b.x, b.y)
            c.stroke()
          },
        })
        continue
      }
      if (primitive.kind === 'sphere') {
        const p = projectPoint({ x: primitive.x, y: primitive.y, z: primitive.z })
        const r = primitive.r * scale
        items.push({
          depth: p.depth,
          draw: (c) => {
            const g = c.createRadialGradient(p.x - r * 0.36, p.y - r * 0.42, r * 0.08, p.x, p.y, r)
            g.addColorStop(0, toneOf(MATERIAL, 1.3))
            g.addColorStop(0.55, WALL_TOP)
            g.addColorStop(1, WALL_SIDE_B)
            c.fillStyle = g
            c.beginPath()
            c.arc(p.x, p.y, r, 0, TAU)
            c.fill()
            // A hairline where the ball meets the light keeps it from melting
            // into a same-toned neighbour.
            c.strokeStyle = 'rgba(44, 54, 46, 0.18)'
            c.lineWidth = 1
            c.stroke()
          },
        })
        continue
      }
      if (primitive.kind === 'capsule3') {
        const a = projectPoint(primitive.a)
        const b = projectPoint(primitive.b)
        const w = Math.max(2, primitive.r * 2 * scale)
        items.push({
          depth: (a.depth + b.depth) / 2,
          draw: (c) => {
            // Horizontal gradient across the column: lit edge on the left,
            // shadow on the right, which is the only cue that says "round".
            const g = c.createLinearGradient(a.x - w / 2, a.y, a.x + w / 2, a.y)
            g.addColorStop(0, toneOf(MATERIAL, 0.92))
            g.addColorStop(0.34, WALL_TOP)
            g.addColorStop(1, WALL_SIDE_B)
            c.strokeStyle = g
            c.lineWidth = w
            c.lineCap = 'round'
            c.beginPath()
            c.moveTo(a.x, a.y)
            c.lineTo(b.x, b.y)
            c.stroke()
          },
        })
        continue
      }
      if (primitive.kind === 'box3') {
        const { min, max } = primitive
        // Six faces, same rules as voxels: only the camera-facing ones.
        // `shade` keeps the same 0/1/2/3 vocabulary as `Face` below (3 = floor)
        // even though a box never emits its underside; narrowing it to 0/1/2
        // made the `!== 3` guard below a comparison TypeScript could prove
        // impossible, which is a build error, not a harmless redundancy.
        const faces: Array<{ n: Vec3; c: Vec3[]; shade: 0 | 1 | 2 | 3 }> = [
          { n: { x: 0, y: 0, z: 1 }, c: [
            { x: min.x, y: min.y, z: max.z },
            { x: max.x, y: min.y, z: max.z },
            { x: max.x, y: max.y, z: max.z },
            { x: min.x, y: max.y, z: max.z },
          ], shade: 0 },
          { n: { x: 0, y: 0, z: -1 }, c: [
            { x: min.x, y: min.y, z: min.z },
            { x: max.x, y: min.y, z: min.z },
            { x: max.x, y: max.y, z: min.z },
            { x: min.x, y: max.y, z: min.z },
          ], shade: 2 },
          { n: { x: 1, y: 0, z: 0 }, c: [
            { x: max.x, y: min.y, z: min.z },
            { x: max.x, y: max.y, z: min.z },
            { x: max.x, y: max.y, z: max.z },
            { x: max.x, y: min.y, z: max.z },
          ], shade: 1 },
          { n: { x: -1, y: 0, z: 0 }, c: [
            { x: min.x, y: min.y, z: min.z },
            { x: min.x, y: max.y, z: min.z },
            { x: min.x, y: max.y, z: max.z },
            { x: min.x, y: min.y, z: max.z },
          ], shade: 2 },
          { n: { x: 0, y: 1, z: 0 }, c: [
            { x: min.x, y: max.y, z: min.z },
            { x: max.x, y: max.y, z: min.z },
            { x: max.x, y: max.y, z: max.z },
            { x: min.x, y: max.y, z: max.z },
          ], shade: 1 },
          { n: { x: 0, y: -1, z: 0 }, c: [
            { x: min.x, y: min.y, z: min.z },
            { x: max.x, y: min.y, z: min.z },
            { x: max.x, y: min.y, z: max.z },
            { x: min.x, y: min.y, z: max.z },
          ], shade: 2 },
        ]
        for (const face of faces) {
          const dot = face.n.x * towardCamera.x + face.n.y * towardCamera.y + face.n.z * towardCamera.z
          if (dot <= 0.001) continue
          const raw = face.c.map(projectPoint)
          let depth = 0
          for (const p of raw) depth += p.depth
          const pts = expandQuad(raw, 0.4)
          const vertical = face.n.z === 0 && face.shade !== 3
          let z0 = face.c[0].z
          let z1 = z0
          for (const corner of face.c) {
            if (corner.z < z0) z0 = corner.z
            if (corner.z > z1) z1 = corner.z
          }
          const fill = shadeFill(face.shade)
          const lo = vertical ? wallAt(face.shade as 1 | 2, z0) : fill
          const hi = vertical ? wallAt(face.shade as 1 | 2, z1) : fill
          // A box face covers a whole wall, so unlike the voxel path it can
          // carry the full height ramp in one gradient. Anchor at the middle
          // of its lower edge; only z changes between the two anchors.
          const midX = (face.c[0].x + face.c[1].x) / 2
          const midY = (face.c[0].y + face.c[1].y) / 2
          const pLo = vertical ? projectPoint({ x: midX, y: midY, z: z0 }) : null
          const pHi = vertical ? projectPoint({ x: midX, y: midY, z: z1 }) : null
          items.push({
            depth: depth / 4,
            draw: (c) => {
              let paint: string | CanvasGradient = fill
              if (vertical && pLo && pHi && z1 - z0 > 0.01 && Math.abs(pHi.y - pLo.y) > 2) {
                const ramp = c.createLinearGradient(pLo.x, pLo.y, pHi.x, pHi.y)
                ramp.addColorStop(0, lo)
                ramp.addColorStop(1, hi)
                paint = ramp
              } else if (vertical) {
                paint = lo
              }
              c.fillStyle = paint
              c.strokeStyle = paint
              c.lineWidth = 2.6
              c.beginPath()
              c.moveTo(pts[0].x, pts[0].y)
              for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i].x, pts[i].y)
              c.closePath()
              c.fill()
              c.stroke()
              if (vertical) {
                const hgt = Math.hypot(pts[2].x - pts[3].x, pts[2].y - pts[3].y)
                if (hgt > 7) {
                  c.strokeStyle = WALL_RIM
                  c.lineWidth = 1.3
                  c.beginPath()
                  c.moveTo(pts[3].x, pts[3].y)
                  c.lineTo(pts[2].x, pts[2].y)
                  c.stroke()
                }
              }
            },
          })
        }
      }
    }

    /* Search trail.
     *
     * Two constraints fight here. Individually legible marks want to be small;
     * a few thousand small marks in one viewport turn into grey fog. So the mark
     * count is capped (density is the thing that cannot be fixed per mark) and
     * the surviving marks are grouped into a handful of batched draws, sorted by
     * depth. One closure per group instead of one per mark is the difference
     * between a drag that tracks the hand and one that lags behind it. */
    if (showExpanded && result && trail.length > 0) {
      const visible = Math.max(0, Math.min(playhead, result.events.length))
      let count = 0
      while (count < trail.length && trail[count].order < visible) count += 1
      if (count > 0) {
        const completed = count >= trail.length
        const stride = Math.max(1, Math.ceil(count / 1300))
        const radiusBase = clamp(scale * 0.13, 1, 2.1)
        const alphaBase = completed ? 0.12 : 0.3
        const freshFrom = visible - Math.max(40, count * 0.12)

        const zSpan = Math.max(1e-6, bounds.max.z - bounds.min.z)
        const marks: Array<{ x: number; y: number; depth: number; alpha: number; r: number }> = []
        for (let i = 0; i < count; i += stride) {
          const mark = trail[i]
          const p = projectPoint({ x: mark.x, y: mark.y, z: mark.z })
          const fresh = clamp((mark.order - freshFrom) / Math.max(1, visible - freshFrom), 0, 1)
          // Expansions high above the floor are real, but a stipple suspended in
          // mid-air reads as dust on the lens. Fading with altitude keeps the
          // swept volume legible on the ground, where it can be compared to it.
          if (p.x < clipX0 || p.x > clipX1 || p.y < clipY0 || p.y > clipY1) continue
          const altitudeFade = 1 - 0.72 * clamp((mark.z - bounds.min.z) / zSpan, 0, 1)
          marks.push({
            x: p.x,
            y: p.y,
            depth: p.depth,
            alpha: alphaBase * (0.42 + 0.58 * mark.phase) * (0.7 + 0.3 * fresh) * altitudeFade,
            r: radiusBase * (0.75 + 0.5 * fresh),
          })
        }
        marks.sort((a, b) => b.depth - a.depth)

        const GROUP = 70
        for (let start = 0; start < marks.length; start += GROUP) {
          const group = marks.slice(start, start + GROUP)
          items.push({
            depth: group[0].depth,
            draw: (c) => {
              for (const mark of group) {
                c.fillStyle = `rgba(${TRAIL}, ${mark.alpha})`
                c.beginPath()
                c.arc(mark.x, mark.y, mark.r, 0, TAU)
                c.fill()
              }
            },
          })
        }
      }
    }

    /* Route. Colour encodes altitude: an orthographic camera has no perspective
       cue for height, so without the tint a climb and a walk are the same
       gesture. Pale sage at the bottom, amber at the top. */
    let route: Array<{ x: number; y: number }> = []
    let routeWidth = 3
    let grown = 0
    // While dragging, the route on screen is the drag's own answer, not the
    // committed plan. It is drawn whole (no replay growth) because the gesture
    // is a question, not a playback.
    const preview = previewRef.current
    // A preview that came back infeasible keeps the committed route on screen
    // rather than blanking it. The marker already says the drop is not real;
    // an empty canvas says the app crashed.
    const path3 = preview?.path ?? result?.path3
    if (showPath && path3 && path3.length > 1) {
      const total = path3.length
      const visible = Math.max(0, Math.min(playhead, result?.events.length ?? 0))
      grown = preview || !result || result.events.length === 0
        ? total
        : Math.max(2, Math.round((visible / result.events.length) * total))
      const { low, span } = altitude
      const lift = (z: number) => {
        const t = clamp((z - low) / span, 0, 1)
        return t < 0.5 ? mix(PATH_LOW, PATH, t * 2) : mix(PATH, PATH_HIGH, (t - 0.5) * 2)
      }

      // The route's own shadow on the floor. This is the cheapest honest way to
      // show that the line is *above* the ground: a climb leaves its shadow
      // behind, and the widening gap is legible without any annotation.
      const groundPts = path3.slice(0, grown).map((p) => projectPoint({ x: p.x, y: p.y, z: floorZ }))
      if (groundPts.length > 1) {
        let gd = 0
        for (const p of groundPts) gd += p.depth
        items.push({
          depth: gd / groundPts.length - 0.012,
          draw: (c) => {
            c.strokeStyle = 'rgba(54, 64, 54, 0.10)'
            c.lineWidth = Math.max(2, scale * 0.11)
            c.lineCap = 'round'
            c.lineJoin = 'round'
            c.beginPath()
            c.moveTo(groundPts[0].x, groundPts[0].y)
            for (let i = 1; i < groundPts.length; i += 1) c.lineTo(groundPts[i].x, groundPts[i].y)
            c.stroke()
          },
        })
      }

      const pts = path3.slice(0, grown).map(projectPoint)
      route = pts
      routeWidth = Math.max(5, scale * 0.42)

      // The pale keyline used to be stroked per segment, round caps and all, so
      // every joint stacked two end-caps on top of each other and the route came
      // out beaded -- bright knots at each turn, thicker than the line itself.
      // One pass for the whole keyline, then the tinted segments butted inside it:
      // a continuous ribbon instead of a chain.
      if (pts.length > 1) {
        let hd = 0
        for (const q of pts) hd += q.depth
        // Glow first: in the dark theme the route is a light source, so it gets a
        // wide, low-alpha pass of its own colour underneath. In the light theme
        // ROUTE_GLOW is transparent and this collapses to nothing.
        items.push({
          depth: hd / pts.length - 0.006,
          draw: (c) => {
            if (ROUTE_GLOW === 'transparent') return
            c.strokeStyle = ROUTE_GLOW
            c.lineWidth = routeWidth + 14
            c.lineCap = 'round'
            c.lineJoin = 'round'
            c.beginPath()
            c.moveTo(pts[0].x, pts[0].y)
            for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i].x, pts[i].y)
            c.stroke()
          },
        })
        items.push({
          depth: hd / pts.length - 0.004,
          draw: (c) => {
            c.strokeStyle = PATH_HALO
            c.lineWidth = routeWidth + 2.4
            c.lineCap = 'round'
            c.lineJoin = 'round'
            c.beginPath()
            c.moveTo(pts[0].x, pts[0].y)
            for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i].x, pts[i].y)
            c.stroke()
          },
        })
      }

      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1]
        const b = pts[i]
        const tint = lift((path3[i].z + path3[i - 1].z) / 2)
        const first = i === 1
        const last = i === pts.length - 1
        items.push({
          depth: (a.depth + b.depth) / 2,
          draw: (c) => {
            // butt ends inside the ribbon, round only at the two real endpoints
            c.lineCap = first || last ? 'round' : 'butt'
            c.beginPath()
            c.moveTo(a.x, a.y)
            c.lineTo(b.x, b.y)
            c.strokeStyle = tint
            c.lineWidth = routeWidth
            c.stroke()
          },
        })
      }
    }

    items.sort((a, b) => b.depth - a.depth)
    for (const item of items) item.draw(ctx)

    /* X-ray pass.
     *
     * Occlusion is the honest default and it is what makes the columns read as
     * solid. But when the goal sits behind one, the route simply stops mid-air
     * and the first thing a viewer concludes is "the planner failed". A faint
     * repeat of the whole route restores continuity without pretending.
     *
     * Deliberately *not* dashed. A dash pattern reads as a second, competing
     * route — on a mostly-visible path it turned the whole route into a dotted
     * line. A solid low-alpha repeat has no rhythm of its own. */
    if (route.length > 1) {
      ctx.save()
      ctx.strokeStyle = 'rgba(248, 242, 226, 0.13)'
      ctx.lineWidth = Math.max(1, routeWidth * 0.42)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(route[0].x, route[0].y)
      for (let i = 1; i < route.length; i += 1) ctx.lineTo(route[i].x, route[i].y)
      ctx.stroke()
      ctx.restore()
    }

    /* A travelling highlight while the timeline is playing: the route is being
       "walked", and a warm point at its tip says where the animation is without
       another progress bar. */
    if (route.length > 1 && result && playhead > 0 && playhead < result.events.length) {
      const tip = route[route.length - 1]
      const haloR = Math.max(8, routeWidth * 3.2)
      const g = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, haloR)
      g.addColorStop(0, 'rgba(255, 252, 240, 0.98)')
      g.addColorStop(0.32, 'rgba(255, 240, 198, 0.55)')
      g.addColorStop(1, 'rgba(255, 236, 184, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(tip.x, tip.y, haloR, 0, TAU)
      ctx.fill()
    }

    /* Endpoints: last and unsorted, because they are controls, not geometry.
     *
     * They share the route's language on purpose — same round cap, same weight,
     * plus a short leader from the marker to the first/last vertex. In a field
     * world the stored endpoint and the nearest lattice centre differ by up to
     * half a cell, and without that leader the route visibly fails to reach its
     * own start, which reads as "the markers and the path don't belong to each
     * other". */
    const ghost = ghostRef.current
    const markerRadius = clamp(routeWidth * 2.05, 7, 13)

    const drawMarker = (point: Vec3, color: string, glow: string, label: string, active: boolean) => {
      const p = projectPoint(point)
      const ground = projectPoint({ x: point.x, y: point.y, z: floorZ })

      // Ground shadow, so the marker is standing somewhere rather than pasted on.
      if (p.y - ground.y > 1.5) {
        ctx.fillStyle = MARKER_SHADOW
        ctx.beginPath()
        ctx.ellipse(ground.x + 2, ground.y + 2, markerRadius * 0.9, markerRadius * 0.46, 0, 0, TAU)
        ctx.fill()
      }

      if (active) {
        const halo = ctx.createRadialGradient(p.x, p.y, markerRadius * 0.6, p.x, p.y, markerRadius + 13)
        halo.addColorStop(0, glow)
        halo.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(p.x, p.y, markerRadius + 13, 0, TAU)
        ctx.fill()
      }

      ctx.beginPath()
      ctx.arc(p.x, p.y, markerRadius + 2.4, 0, TAU)
      ctx.fillStyle = MARKER_RING
      ctx.fill()
      ctx.strokeStyle = 'rgba(30, 38, 32, 0.16)'
      ctx.lineWidth = 1
      ctx.stroke()

      const body = ctx.createRadialGradient(
        p.x - markerRadius * 0.36,
        p.y - markerRadius * 0.42,
        markerRadius * 0.12,
        p.x,
        p.y,
        markerRadius,
      )
      body.addColorStop(0, mix(color, '#ffffff', 0.24))
      body.addColorStop(1, color)
      ctx.beginPath()
      ctx.arc(p.x, p.y, markerRadius, 0, TAU)
      ctx.fillStyle = body
      ctx.fill()

      ctx.fillStyle = MARKER_INK
      ctx.font = `700 ${Math.max(9, markerRadius * 0.92)}px "Cascadia Mono", ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, p.x, p.y + 0.5)
    }

    // The marker is drawn where the drop will land — the snapped cell — and the
    // route starts from the same cell, so the picture and the result are one
    // object. The finger that is doing the dragging is drawn as a thin dashed
    // tie, which is the only place the two are allowed to disagree.
    const eased = dragEaseRef.current
    const dragged = ghost ? (eased ?? ghost.anchor) : null
    const startAt = ghost?.which === 'start' && dragged ? dragged : start
    const goalAt = ghost?.which === 'goal' && dragged ? dragged : goal
    const startAnchor = ghost?.which === 'start' ? ghost.anchor : start
    const goalAnchor = ghost?.which === 'goal' ? ghost.anchor : goal

    if (route.length > 1) {
      ctx.lineCap = 'round'
      const leader = (from: Vec3, to: { x: number; y: number }) => {
        const p = projectPoint(from)
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(to.x, to.y)
        ctx.strokeStyle = PATH_HALO
        ctx.lineWidth = routeWidth + 2
        ctx.stroke()
        ctx.strokeStyle = PATH
        ctx.lineWidth = routeWidth
        ctx.stroke()
      }
      leader(startAnchor, route[0])
      leader(goalAnchor, route[route.length - 1])
    }

    drawMarker(startAt, START, START_GLOW, 'S', ghost?.which === 'start' || pickMode === 'start' || hoverRef.current === 'start')
    drawMarker(goalAt, GOAL, GOAL_GLOW, 'G', ghost?.which === 'goal' || pickMode === 'goal' || hoverRef.current === 'goal')

    /* Where a dragged marker actually is.
     *
     * An axonometric view has no depth cue, so a marker one storey up looks
     * exactly like one on the floor in front of it. That is the whole reason a
     * drag in this view so often ends somewhere the hand did not mean. The plumb
     * line and the square it lands on add back the one direction the eye cannot
     * judge: the marker's own vertical.
     *
     * The marker itself sits on the snapped cell, so this block draws *around*
     * the thing that will be committed rather than beside it. */
    if (ghost) {
      const anchorPoint = dragged ?? ghost.anchor
      const p = projectPoint(anchorPoint)
      const finger = projectPoint(ghost.point)
      const ground = projectPoint({ x: anchorPoint.x, y: anchorPoint.y, z: floorZ })
      const lifted = Math.hypot(p.x - ground.x, p.y - ground.y) > 2.5
      // `sliding` is the finger over something the anchor had to leave; the
      // route is still real, so this is a hint, not an error. An infeasible
      // search is an error.
      const bad = previewRef.current !== null && previewRef.current.path === null
      const tone = ghost.sliding || bad ? WARN : GUIDE

      // Plumb line: the depth cue an axonometric view does not have.
      if (lifted) {
        ctx.save()
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1
        ctx.strokeStyle = tone
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(ground.x, ground.y)
        ctx.stroke()
        ctx.restore()
      }

      // The finger. Always drawn, not only when the snap had to work: a
      // control that follows the pointer exactly should still show what it is
      // following, otherwise "the marker is lagging" is indistinguishable from
      // "the marker is wrong".
      const tieLength = Math.hypot(finger.x - p.x, finger.y - p.y)
      if (tieLength > 3) {
        ctx.save()
        ctx.setLineDash([2, 3])
        ctx.strokeStyle = ghost.sliding || bad ? WARN : GUIDE
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(finger.x, finger.y)
        ctx.stroke()
        ctx.restore()

        ctx.save()
        ctx.strokeStyle = ghost.sliding || bad ? WARN : GUIDE
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(finger.x, finger.y, 2.6, 0, TAU)
        ctx.stroke()
        ctx.restore()
      }

      if (bad) {
        ctx.save()
        ctx.setLineDash([3, 3])
        ctx.strokeStyle = WARN
        ctx.lineWidth = 1.4
        ctx.beginPath()
        ctx.arc(p.x, p.y, markerRadius + 6, 0, TAU)
        ctx.stroke()
        ctx.restore()
      }

      // Footprint: the cell the drop will actually land in. Open square, so a
      // landing point reads as a place rather than a smudge.
      const half = markerRadius * 0.92
      ctx.save()
      if (ghost.sliding || bad) ctx.setLineDash([3, 3])
      ctx.strokeStyle = tone
      ctx.lineWidth = 1.2
      ctx.strokeRect(ground.x - half, ground.y - half * 0.62, half * 2, half * 1.24)
      ctx.restore()
    }

    if (pickMode !== 'none') {
      ctx.strokeStyle = pickMode === 'start' ? 'rgba(47,93,80,0.42)' : 'rgba(164,95,67,0.42)'
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 1
      ctx.strokeRect(1, 1, width - 2, height - 2)
      ctx.setLineDash([])
    }
  }, [geometry, result, start, goal, playhead, showExpanded, showPath, pickMode, size, columns, trail, altitude, theme])

  useEffect(() => {
    drawRef.current = paint
    schedulePaint()
  }, [paint, schedulePaint])

  /* ----------------------------------------------------------- picking --- */
  /**
   * Screen → world, on the world's floor plane.
   *
   * Uses `frameRef` — the transform the last painted frame used — instead of
   * recomputing it. Two copies of this maths drifting apart by a pad or a zoom
   * would put the marker a few pixels from the cursor, and that symptom is
   * indistinguishable from "the click is broken".
   */
  const toWorldOnFloor = useCallback(
    (screenX: number, screenY: number, planeZ = geometry.pickZ ?? geometry.bounds.min.z): Vec3 | null => {
      const frame = frameRef.current
      if (!frame) return null
      return unprojectIn(frame, screenX, screenY, planeZ)
    },
    [geometry],
  )

  /**
   * The world point under the cursor, on the surface the cursor is over.
   *
   * One ground plane is enough for a flat field, but a voxel world can have
   * stacked floors — and resolving every click onto the ground layer silently
   * forbids the second storey: a goal placed anywhere in the shaft ends up on
   * layer one. So for volumes we walk the view ray from far to near and stop at
   * the first solid cell, returning the free sample just in front of it.
   */
  const pickPoint = useCallback(
    (screenX: number, screenY: number): Vec3 | null => {
      const plane = toWorldOnFloor(screenX, screenY)
      const frame = frameRef.current
      if (!plane || !frame || world.kind !== 'voxel3d') return plane
      const v = world.scene.volume
      const planeOf = v.width * v.height
      const solidAt = (p: Vec3) => {
        const x = Math.floor(p.x / v.spacing)
        const y = Math.floor(p.y / v.spacing)
        const z = Math.floor(p.z / v.spacing)
        if (x < 0 || y < 0 || z < 0 || x >= v.width || y >= v.height || z >= v.depth) return false
        return v.cells[z * planeOf + y * v.width + x] === 1
      }
      // Walk the pixel's own view ray. `viewRay` is derived from `projectIn` —
      // the same equation `unprojectIn` solves — so marching along it cannot
      // drift away from what the screen shows.
      const dir = viewRay(frame)
      const step = v.spacing * 0.5
      let previous: Vec3 | null = null
      for (let i = -160; i <= 160; i += 1) {
        const p = {
          x: plane.x + dir.x * step * i,
          y: plane.y + dir.y * step * i,
          z: plane.z + dir.z * step * i,
        }
        if (solidAt(p)) return previous ?? plane
        previous = p
      }
      return plane
    },
    [toWorldOnFloor, world],
  )

  const screenOf = useCallback((point: Vec3) => {
    const frame = frameRef.current
    if (!frame) return null
    const at = projectIn(frame, point)
    return { x: at.x, y: at.y }
  }, [])

  const localOf = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  /** Which endpoint, if any, is under the cursor. */
  const endpointAt = (screenX: number, screenY: number): 'start' | 'goal' | null => {
    let best: 'start' | 'goal' | null = null
    let bestDistance = 19
    for (const which of ['start', 'goal'] as const) {
      const at = screenOf(which === 'start' ? start : goal)
      if (!at) continue
      const distance = Math.hypot(screenX - at.x, screenY - at.y)
      if (distance <= bestDistance) {
        best = which
        bestDistance = distance
      }
    }
    return best
  }

  /* -------------------------------------------------------- gestures ----- */
  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    const canvas = canvasRef.current
    canvas?.setPointerCapture?.(event.pointerId)
    const local = localOf(event.clientX, event.clientY)
    // Orbit maths works off the *target*, not the drawn value: the drawn value
    // is chasing the target, so anchoring the gesture to it would lose a
    // fraction of every drag to the easing lag and then keep it forever.
    const view = targetRef.current

    // Grabbing S or G outranks everything: in the 2D canvas the markers are
    // draggable at all times, and having to arm a mode first is exactly the kind
    // of asymmetry that makes a view feel like a different application.
    const grabbed = onPick ? endpointAt(local.x, local.y) : null
    const grabbedAt = grabbed === 'start' ? start : goal
    // Grab offset: the marker must not jump to the cursor on the first frame.
    // The gesture carries the point, it does not teleport it — so remember the
    // world-space gap between the hand and the marker and re-apply it every move.
    const grabRaw = grabbed ? toWorldOnFloor(local.x, local.y, grabbedAt.z) : null
    dragRef.current = {
      mode: grabbed ?? 'orbit',
      grabOffset: grabRaw
        ? { x: grabbedAt.x - grabRaw.x, y: grabbedAt.y - grabRaw.y }
        : { x: 0, y: 0 },
      x: event.clientX,
      y: event.clientY,
      yaw: view.yaw,
      pitch: view.pitch,
      lastX: event.clientX,
      lastY: event.clientY,
      lastT: performance.now(),
      moved: 0,
      pick: pickMode,
      // The gesture is planar: the altitude at the moment of the grab is the
      // altitude for the whole drag. Held in a ref, not read from `start` later,
      // because `start` moves during the drag.
      planeZ: grabbed ? grabbedAt.z : 0,
      anchor: grabbedAt,
      goodAnchor: grabbedAt,
      lastKey: '',
      lastEmit: 0,
    }
    // A grab cancels any coasting: the scene must stop where the hand lands.
    spinRef.current = { yaw: 0, pitch: 0 }
    homeRef.current = false
    // A new gesture owns the camera; a stale zoom pivot would fight it.
    zoomAnchorRef.current = null
    trailRef.current = [{ t: performance.now(), x: event.clientX, y: event.clientY }]

    if (grabbed) {
      lastGrabRef.current = grabbed
      ghostRef.current = { which: grabbed, point: grabbedAt, anchor: grabbedAt, sliding: false }
      dragEaseRef.current = { ...grabbedAt }
      previewRef.current = null
      if (canvas) canvas.style.cursor = 'grabbing'
      schedulePaint()
    }
  }

  /**
   * Re-plan for the current anchor, but behind a paint.
   *
   * The search blocks the main thread for 20–56 ms. Calling it straight from
   * pointermove spends the frame that would have moved the marker on the search
   * instead, so the hand moves and the picture does not — which is the "not
   * smooth" no easing can fix. Queueing behind a frame plus a task lets the
   * marker reach the screen first; the route lands a frame later.
   *
   * Coalescing comes for free: only the newest anchor survives, so a fast sweep
   * costs one search per DRAG_PLAN_MS rather than one per event.
   */
  const planSoon = (which: 'start' | 'goal', point: Vec3) => {
    if (commitRef.current) {
      commitRef.current.point = point
      commitRef.current.which = which
      return
    }
    const handle = window.requestAnimationFrame(() => {
      const queued = commitRef.current
      window.setTimeout(() => {
        if (!queued || commitRef.current !== queued) return
        commitRef.current = null
        if (!dragRef.current) return
        const path = previewPlan?.(queued.which, queued.point) ?? null
        previewRef.current = { path }
        if (path) dragRef.current.goodAnchor = queued.point
        schedulePaint()
      }, 0)
    })
    commitRef.current = { which, point, handle }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const local = localOf(event.clientX, event.clientY)
    const drag = dragRef.current

    if (!drag) {
      // Say "this is draggable" before the user has to discover it.
      const hit = onPick ? endpointAt(local.x, local.y) : null
      if (hit !== hoverRef.current) {
        hoverRef.current = hit
        schedulePaint()
      }
      const canvas = canvasRef.current
      if (canvas) canvas.style.cursor = hit ? 'grab' : ''
      return
    }

    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy))

    // Shift = look straight down while the hand is moving.
    //
    // In a perspective view a screen pixel and a map cell cannot line up: the
    // error is z·(Z_LIFT−1)·cot(pitch) cells, and at a 45° pitch that is most of
    // a cell. At π/2 the cotangent is zero and the mapping is exact, so the only
    // honest way to place a point precisely is to look down. The angle is
    // restored on release, so the view is a temporary instrument, not a mode.
    if (drag.mode === 'start' || drag.mode === 'goal') {
      targetRef.current.pitch = event.shiftKey ? Math.PI / 2 - 0.001 : drag.pitch
    }

    if (drag.mode === 'orbit') {
      const target = targetRef.current
      // "Grab the scene" semantics: drag right and the volume swings right, which
      // means yaw *decreases* — yaw is the camera's bearing around the scene, not
      // the scene's rotation about the camera.
      //
      // Both go to the target, not to the drawn value. The picture then arrives
      // a frame or two later, smoothly, and a stuttering pointer just means the
      // target moves in steps the easing rounds off.
      target.yaw = drag.yaw - dx * 0.0072
      target.pitch = softPitch(drag.pitch + dy * 0.0052)

      // Samples for the release coast. Not a per-move velocity: a single
      // pointermove can be a stutter, and averaging the last two deltas means a
      // busy frame reads as "stopped" exactly when the flick was fastest.
      const now = performance.now()
      const trail = trailRef.current
      trail.push({ t: now, x: event.clientX, y: event.clientY })
      while (trail.length > 2 && now - trail[0].t > FLICK_WINDOW_MS) trail.shift()
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      drag.lastT = now
      ensureAnimation()
      return
    }

    // Endpoint drag. Alt unlocks the altitude (the pointer picks the surface it
    // is over, which is how you move a point to the upper storey on purpose);
    // without Alt the gesture is planar, so the altitude cannot drift while the
    // hand moves sideways.
    const base = event.altKey
      ? pickPoint(local.x, local.y)
      : toWorldOnFloor(local.x, local.y, drag.planeZ)
    if (!base) return
    const raw = { x: base.x + drag.grabOffset.x, y: base.y + drag.grabOffset.y, z: base.z }

    // The anchor is the nearest legal cell near the finger. When there is none
    // — the hand is inside a column, or over a pocket the inflation sealed —
    // the anchor holds at its last legal value: the marker stays on the last
    // place that worked and the dashed tie grows to show by how much the hand
    // is being overruled. That is what sliding along a wall looks like;
    // stopping dead is what it looked like before.
    const slide = snapOnLayer(world, raw, 0.9, SLIDE_CELLS)
    if (slide) drag.anchor = slide
    ghostRef.current = {
      which: drag.mode,
      point: raw,
      anchor: drag.anchor,
      sliding: !slide,
    }
    // The marker walks to the anchor; the finger point is only a hint.
    ensureAnimation()

    // A move inside the same cell changes nothing the planner can see, so it
    // costs nothing: the marker still tracks the hand, the route holds still.
    const key = cellKey(drag.anchor)
    const now = performance.now()
    if (key === drag.lastKey || now - drag.lastEmit < DRAG_PLAN_MS) return
    drag.lastKey = key
    drag.lastEmit = now
    planSoon(drag.mode, drag.anchor)
  }
  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (commitRef.current) {
      window.cancelAnimationFrame(commitRef.current.handle)
      commitRef.current = null
    }
    if (canvasRef.current) canvasRef.current.style.cursor = ''
    if (!drag) return
    const local = localOf(event.clientX, event.clientY)

    if (drag.mode === 'orbit') {
      // Coast only if the hand was still moving when it let go. Velocity comes
      // from a fixed time window (~90 ms), so it is the same number whether the
      // last frame was 8 ms or 40 ms away — the old version divided by a single
      // frame's dt, which is why the same flick could either die instantly or
      // send the scene sailing.
      const now = performance.now()
      const trail = trailRef.current
      const recent = trail.filter((sample) => now - sample.t <= FLICK_WINDOW_MS)
      const first = recent[0]
      const lastSample = recent[recent.length - 1]
      if (first && lastSample && recent.length >= 2 && now - lastSample.t < 60) {
        const span = Math.max(8, lastSample.t - first.t) / 1000
        spinRef.current = {
          // Capped: a fast flick across 400 px in 90 ms is 5.7 rad/s, which
          // would spin the volume twice. The cap is what stops "it kept going".
          yaw: clamp((-(lastSample.x - first.x) * 0.0072) / span, -6, 6),
          pitch: clamp(((lastSample.y - first.y) * 0.0052) / span, -3, 3),
        }
      } else {
        spinRef.current = { yaw: 0, pitch: 0 }
      }
      ensureAnimation()
      hoverRef.current = onPick ? endpointAt(local.x, local.y) : null
      schedulePaint()
    }

    if (drag.mode === 'start' || drag.mode === 'goal') {
      targetRef.current.pitch = drag.pitch
      // A tap on a marker is not a move. Committing it anyway would run a full
      // 3D search to produce an identical result, which reads as a hitch.
      if (drag.moved < 3) {
        ghostRef.current = null
        dragEaseRef.current = null
        previewRef.current = null
        schedulePaint()
        return
      }
      // The drop lands on the anchor — the last cell that was legal on this
      // layer — never on the raw point. If that cell turned out to have no
      // route, it lands on the last anchor that did: "nearest place it works"
      // is the 2D behaviour, and it is the only answer that never dead-ends.
      const unreachable = previewRef.current !== null && previewRef.current.path === null
      const landed = unreachable ? drag.goodAnchor : drag.anchor
      ghostRef.current = null
      // Park the eased marker on the cell it committed to, so the next grab
      // starts where this one ended instead of walking across from the finger.
      dragEaseRef.current = { ...landed }
      previewRef.current = null
      // Clear the ghost before the new result lands, otherwise the marker snaps
      // back to the old endpoint for the duration of the search.
      schedulePaint()
      onPick?.(drag.mode, landed)
      return
    }

    // A press that never moved is a click: in pick mode it places the point.
    // Treating it as a drag made "click the floor" and "orbit the view" the same
    // gesture, so every click also nudged the camera.
    if (drag.pick !== 'none' && drag.moved < 5) {
      const point = pickPoint(local.x, local.y)
      if (point) onPick?.(drag.pick, point)
    }
  }

  const handlePointerLeave = () => {
    if (!dragRef.current && hoverRef.current) {
      hoverRef.current = null
      if (canvasRef.current) canvasRef.current.style.cursor = ''
      schedulePaint()
    }
  }

  /**
   * Arrow keys move the last grabbed endpoint one cell (Shift: four).
   *
   * Perspective can never be precise to a cell — that is geometry, not a bug —
   * so the only honest way to finish a placement is the keyboard. It is bound to
   * the canvas rather than the window: arrows still belong to the page elsewhere.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!onPick) return
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    const dir = dirs[event.key]
    if (!dir) return
    event.preventDefault()
    const step =
      world.kind === 'voxel3d'
        ? world.scene.volume.spacing
        : world.kind === 'grid2d'
          ? 1
          : world.scene.resolution
    const which = lastGrabRef.current
    const at = which === 'start' ? start : goal
    const raw = {
      x: at.x + dir[0] * step * (event.shiftKey ? 4 : 1),
      y: at.y + dir[1] * step * (event.shiftKey ? 4 : 1),
      z: at.z,
    }
    const next = snapOnLayer(world, raw, 0.9, SLIDE_CELLS)
    if (!next) return
    dragEaseRef.current = { ...next }
    ghostRef.current = null
    previewRef.current = null
    schedulePaint()
    onPick(which, next)
  }

  // Wheel must be a native, non-passive listener. React registers `onWheel` as
  // passive, so `preventDefault()` there is ignored: zooming also scrolled the
  // page underneath the canvas, which is most of why the controls felt wrong.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      // Normalise line/page deltas, then scale exponentially: a notch and a
      // trackpad swipe should feel proportional, and repeated notches should
      // compound instead of adding a fixed step.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
      const next = targetRef.current.zoom * Math.exp(-event.deltaY * unit * 0.0016)
      const zoom = clamp(next, ZOOM_MIN, ZOOM_MAX)
      if (Math.abs(zoom - targetRef.current.zoom) < 1e-6) return
      targetRef.current.zoom = zoom
      homeRef.current = false

      // Zoom toward the cursor, not toward the middle. Park the world point
      // that is under the pointer on its own pixel and let the frame loop keep
      // it there while the scale moves: what you are looking at stays put, and
      // the thing you are zooming in on is the thing you pointed at.
      const rect = canvas.getBoundingClientRect()
      const frame = frameRef.current
      if (frame) {
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        const planeZ = geometry.pickZ ?? geometry.bounds.min.z
        zoomAnchorRef.current = { x, y, world: unprojectIn(frame, x, y, planeZ) }
      }
      ensureAnimation()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [ensureAnimation, geometry])

  const zoomBy = useCallback(
    (factor: number) => {
      targetRef.current.zoom = clamp(targetRef.current.zoom * factor, ZOOM_MIN, ZOOM_MAX)
      homeRef.current = false
      // The +/− buttons and the double-click reset have no cursor to zoom
      // toward; drop the pivot so the frame does not get dragged to a stale one.
      zoomAnchorRef.current = null
      ensureAnimation()
    },
    [ensureAnimation],
  )

  /** Home view. Also bound to double-click, the gesture people try first. */
  const resetView = useCallback(() => {
    spinRef.current = { yaw: 0, pitch: 0 }
    // Home owns the framing: a zoom pivot left over from the wheel would drag
    // the picture sideways while the pan is trying to return to centre.
    zoomAnchorRef.current = null
    homeRef.current = true
    ensureAnimation()
  }, [ensureAnimation])

  return (
    <div className="scene3d" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className={`scene3d-canvas ${pickMode !== 'none' ? 'is-picking' : ''}`}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={resetView}
      />
      <div className="scene3d-hint">
        <span>{tr(lang, '拖动旋转')}</span>
        <span>{tr(lang, '滚轮缩放')}</span>
        <span>{tr(lang, '拖 S / G 换位置 · 按住 Alt 换高度')}</span>
      </div>
      <div className="scene3d-zoom">
        <button type="button" title={tr(lang, '放大')} onClick={() => zoomBy(1.16)}>
          +
        </button>
        <button type="button" title={tr(lang, '缩小')} onClick={() => zoomBy(1 / 1.16)}>
          −
        </button>
        <button type="button" title={tr(lang, '复位视角')} onClick={resetView}>
          ⟲
        </button>
      </div>
    </div>
  )
}
