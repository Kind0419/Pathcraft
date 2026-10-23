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
import { tr, useLang } from '../lib/i18n'

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
const MATERIAL = '#7d867d'

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
const FLOOR = '#bdbdb0'
const WALL_TOP = toneOf(MATERIAL, 1.3)
const WALL_SIDE_A = toneOf(MATERIAL, 0.86)
const WALL_SIDE_B = toneOf(MATERIAL, 0.68)

const PAPER_TOP = '#fcfbf6'
const PAPER_MID = '#f7f4ea'
const PAPER_LOW = '#eeebe0'
const PLATE = '#e2ded0'
const PLATE_EDGE = 'rgba(96, 104, 92, 0.16)'

// The path is the one element that must survive every background: it crosses the
// pale floor, then a wall's top face, then a wall's shaded side. A single flat
// colour cannot do that — pine on the walls goes to near-black. So the route is
// drawn as a light ribbon with a dark underlay, which reads on all three.
const PATH = '#f8f2e2'
const PATH_LOW = '#c3dccb'
const PATH_HIGH = '#eeb478'
const PATH_HALO = 'rgba(24, 33, 27, 0.72)'
const START = '#2f5d50'
const GOAL = '#a45f43'
const START_GLOW = 'rgba(47, 93, 80, 0.20)'
const GOAL_GLOW = 'rgba(164, 95, 67, 0.20)'
const TRAIL = '46, 72, 60'

const HOME_VIEW = { yaw: -0.66, pitch: 0.86, zoom: 1 }
const PITCH_MIN = 0.16
const PITCH_MAX = 1.42
const ZOOM_MIN = 0.55
const ZOOM_MAX = 3.6

interface Bounds {
  min: Vec3
  max: Vec3
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

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/**
 * The camera fit — computed once, used by both the renderer and by picking.
 *
 * Picking inverts exactly this transform. If two copies of it drifted apart (a
 * different pad, a different corner set) a click would drop the start marker
 * slightly away from the cursor, and that symptom — "the scene is wrong" — is
 * nowhere near its cause. So it lives in one function, called from both places.
 */
function fitView(bounds: Bounds, width: number, height: number, yaw: number, pitch: number, zoom: number) {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < 8; i += 1) {
    const x = i & 1 ? bounds.max.x : bounds.min.x
    const y = i & 2 ? bounds.max.y : bounds.min.y
    const z = i & 4 ? bounds.max.z : bounds.min.z
    const px = x * cy + y * sy
    const ry = -x * sy + y * cy
    const py = -(ry * sp + z * cp)
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }
  const pad = 20
  const fit = Math.min(
    (width - pad * 2) / Math.max(1e-6, maxX - minX),
    (height - pad * 2) / Math.max(1e-6, maxY - minY),
  )
  const scale = fit * zoom
  return {
    scale,
    originX: width / 2 - ((minX + maxX) / 2) * scale,
    originY: height / 2 - ((minY + maxY) / 2) * scale,
    cy,
    sy,
    cp,
    sp,
  }
}

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

type Frame = ReturnType<typeof fitView>

/** Project one world point through a frame. Also returns its sort depth. */
function projectIn(frame: Frame, p: Vec3) {
  const rx = p.x * frame.cy + p.y * frame.sy
  const ry = -p.x * frame.sy + p.y * frame.cy
  return {
    x: frame.originX + rx * frame.scale,
    y: frame.originY - (ry * frame.sp + p.z * frame.cp) * frame.scale,
    depth: ry * frame.cp - p.z * frame.sp,
  }
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
        shade === 3 ? FLOOR : shade === 0 ? toneOf(MATERIAL, 1.2 + 0.26 * (z / Math.max(1, depth - 1))) : WALL_SIDE_B
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
}: Props) {
  const lang = useLang()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  /* ------------------------------------------------------------- camera --- */
  // Authoritative in a ref: dragging must not re-render React. `zoomTarget` is
  // where the easing is heading; `view.zoom` is where it is right now.
  const viewRef = useRef<View>({ ...HOME_VIEW })
  const zoomTargetRef = useRef(HOME_VIEW.zoom)
  const spinRef = useRef({ yaw: 0, pitch: 0 })
  const homeRef = useRef(false)

  /* -------------------------------------------------------- interaction --- */
  // A dragged endpoint is previewed here rather than committed to the planner: a
  // 3D search costs 70–160 ms, so re-planning on every pointermove would turn a
  // drag into a slideshow. The marker follows the cursor; the route stays put
  // until release.
  const ghostRef = useRef<{ which: 'start' | 'goal'; point: Vec3 } | null>(null)
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
  } | null>(null)
  /** The exact transform the last frame was drawn with, reused for hit-testing. */
  const frameRef = useRef<Frame | null>(null)

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
  }, [world])

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
   * The frame loop: eased zoom, orbit inertia, and the home tween.
   *
   * One loop for all three because they are the same problem — a value that
   * should approach a target instead of jumping to it. It parks itself as soon
   * as everything is settled, so an idle canvas costs nothing.
   */
  const ensureAnimation = useCallback(() => {
    if (animRef.current != null) return
    const frame = () => {
      const view = viewRef.current
      let busy = false

      const dz = zoomTargetRef.current - view.zoom
      if (Math.abs(dz) > 0.0006) {
        view.zoom += dz * 0.24
        busy = true
      } else {
        view.zoom = zoomTargetRef.current
      }

      const spin = spinRef.current
      if (Math.abs(spin.yaw) > 1e-4 || Math.abs(spin.pitch) > 1e-4) {
        view.yaw += spin.yaw
        view.pitch = clamp(view.pitch + spin.pitch, PITCH_MIN, PITCH_MAX)
        spin.yaw *= 0.9
        spin.pitch *= 0.9
        busy = true
      } else {
        spin.yaw = 0
        spin.pitch = 0
      }

      if (homeRef.current) {
        // Shortest way round: after a few orbits yaw may be at +9 rad, and
        // tweening to −0.66 the naive way spins the scene twice.
        const targetYaw = HOME_VIEW.yaw + TAU * Math.round((view.yaw - HOME_VIEW.yaw) / TAU)
        view.yaw += (targetYaw - view.yaw) * 0.18
        view.pitch += (HOME_VIEW.pitch - view.pitch) * 0.18
        const homeZoom = HOME_VIEW.zoom
        view.zoom += (homeZoom - view.zoom) * 0.18
        zoomTargetRef.current = view.zoom
        const settled =
          Math.abs(targetYaw - view.yaw) < 0.003 &&
          Math.abs(HOME_VIEW.pitch - view.pitch) < 0.003 &&
          Math.abs(homeZoom - view.zoom) < 0.004
        if (settled) {
          view.yaw = HOME_VIEW.yaw
          view.pitch = HOME_VIEW.pitch
          view.zoom = homeZoom
          zoomTargetRef.current = homeZoom
          homeRef.current = false
        } else {
          busy = true
        }
      }

      schedulePaint()
      animRef.current = busy ? requestAnimationFrame(frame) : null
    }
    animRef.current = requestAnimationFrame(frame)
  }, [schedulePaint])

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
    const frame = fitView(bounds, width, height, view.yaw, view.pitch, view.zoom)
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
    key.addColorStop(0, 'rgba(255, 255, 255, 0.62)')
    key.addColorStop(0.55, 'rgba(255, 255, 255, 0.16)')
    key.addColorStop(1, 'rgba(255, 255, 255, 0)')
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
          c.fillStyle = 'rgba(40, 48, 41, 0.105)'
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
            c.fillStyle = 'rgba(40, 48, 41, 0.1)'
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
    for (const face of geometry.faces) {
      const dot = face.nx * towardCamera.x + face.ny * towardCamera.y + face.nz * towardCamera.z
      if (dot <= 0.001) continue
      const raw = face.corners.map(projectPoint)
      let depth = 0
      for (const p of raw) depth += p.depth
      depth /= raw.length
      const fill = face.fill
      const pts = expandQuad(raw, 0.4)
      items.push({
        depth,
        draw: (c) => {
          c.fillStyle = fill
          c.strokeStyle = fill
          c.lineWidth = 1.6
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
        const faces: Array<{ n: Vec3; c: Vec3[]; shade: 0 | 1 | 2 }> = [
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
          const fill = shadeFill(face.shade)
          const pts = expandQuad(raw, 0.4)
          items.push({
            depth: depth / 4,
            draw: (c) => {
              c.fillStyle = fill
              c.strokeStyle = fill
              c.lineWidth = 1.6
              c.beginPath()
              c.moveTo(pts[0].x, pts[0].y)
              for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i].x, pts[i].y)
              c.closePath()
              c.fill()
              c.stroke()
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
    const path3 = result?.path3
    if (showPath && path3 && path3.length > 1) {
      const total = path3.length
      const visible = Math.max(0, Math.min(playhead, result!.events.length))
      grown = result!.events.length === 0 ? total : Math.max(2, Math.round((visible / result!.events.length) * total))
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
      routeWidth = Math.max(3, scale * 0.21)
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1]
        const b = pts[i]
        const tint = lift((path3[i].z + path3[i - 1].z) / 2)
        items.push({
          depth: (a.depth + b.depth) / 2,
          draw: (c) => {
            c.lineCap = 'round'
            c.beginPath()
            c.moveTo(a.x, a.y)
            c.lineTo(b.x, b.y)
            c.strokeStyle = PATH_HALO
            c.lineWidth = routeWidth + 2
            c.stroke()
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
        ctx.fillStyle = 'rgba(40, 48, 41, 0.12)'
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
      ctx.fillStyle = 'rgba(252, 250, 244, 0.97)'
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

      ctx.fillStyle = '#fdfcf8'
      ctx.font = `700 ${Math.max(9, markerRadius * 0.92)}px "Cascadia Mono", ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, p.x, p.y + 0.5)
    }

    const startAt = ghost?.which === 'start' ? ghost.point : start
    const goalAt = ghost?.which === 'goal' ? ghost.point : goal

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
      leader(startAt, route[0])
      leader(goalAt, route[route.length - 1])
    }

    drawMarker(startAt, START, START_GLOW, 'S', ghost?.which === 'start' || pickMode === 'start' || hoverRef.current === 'start')
    drawMarker(goalAt, GOAL, GOAL_GLOW, 'G', ghost?.which === 'goal' || pickMode === 'goal' || hoverRef.current === 'goal')

    if (pickMode !== 'none') {
      ctx.strokeStyle = pickMode === 'start' ? 'rgba(47,93,80,0.42)' : 'rgba(164,95,67,0.42)'
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 1
      ctx.strokeRect(1, 1, width - 2, height - 2)
      ctx.setLineDash([])
    }
  }, [geometry, result, start, goal, playhead, showExpanded, showPath, pickMode, size, columns, trail, altitude])

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
    (screenX: number, screenY: number): Vec3 | null => {
      const frame = frameRef.current
      if (!frame) return null
      const { bounds } = geometry
      const wx = (screenX - frame.originX) / frame.scale
      const wy = -(screenY - frame.originY) / frame.scale
      const planeZ = geometry.pickZ ?? bounds.min.z
      // wy = ry·sp + z·cp  →  ry = (wy − z·cp) / sp
      const ry = (wy - planeZ * frame.cp) / Math.max(1e-6, frame.sp)
      const x = wx * frame.cy - ry * frame.sy
      const y = wx * frame.sy + ry * frame.cy
      return { x, y, z: planeZ }
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
      // Unit vector pointing at the camera. Projecting along it leaves the screen
      // position unchanged, so this walks the ray through the pixel.
      const dir = { x: frame.cp * frame.sy, y: -frame.cp * frame.cy, z: frame.sp }
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
    const view = viewRef.current

    // Grabbing S or G outranks everything: in the 2D canvas the markers are
    // draggable at all times, and having to arm a mode first is exactly the kind
    // of asymmetry that makes a view feel like a different application.
    const grabbed = onPick ? endpointAt(local.x, local.y) : null
    dragRef.current = {
      mode: grabbed ?? 'orbit',
      x: event.clientX,
      y: event.clientY,
      yaw: view.yaw,
      pitch: view.pitch,
      lastX: event.clientX,
      lastY: event.clientY,
      lastT: performance.now(),
      moved: 0,
      pick: pickMode,
    }
    // A grab cancels any coasting: the scene must stop where the hand lands.
    spinRef.current = { yaw: 0, pitch: 0 }
    homeRef.current = false

    if (grabbed) {
      ghostRef.current = { which: grabbed, point: grabbed === 'start' ? start : goal }
      if (canvas) canvas.style.cursor = 'grabbing'
      schedulePaint()
    }
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

    if (drag.mode === 'orbit') {
      const view = viewRef.current
      // "Grab the scene" semantics: drag right and the volume swings right, which
      // means yaw *decreases* — yaw is the camera's bearing around the scene, not
      // the scene's rotation about the camera.
      view.yaw = drag.yaw - dx * 0.0072
      view.pitch = clamp(drag.pitch + dy * 0.0052, PITCH_MIN, PITCH_MAX)

      // Track velocity for the release coast. Smoothed, because a single
      // pointermove can be a stutter rather than a flick.
      const now = performance.now()
      const dt = Math.max(8, now - drag.lastT)
      const stepYaw = (-(event.clientX - drag.lastX) * 0.0072) / dt
      const stepPitch = ((event.clientY - drag.lastY) * 0.0052) / dt
      spinRef.current.yaw = spinRef.current.yaw * 0.55 + stepYaw * 16.7 * 0.45
      spinRef.current.pitch = spinRef.current.pitch * 0.55 + stepPitch * 16.7 * 0.45
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      drag.lastT = now
      schedulePaint()
      return
    }

    const point = pickPoint(local.x, local.y)
    if (point) {
      ghostRef.current = { which: drag.mode, point }
      schedulePaint()
    }
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = ''
    if (!drag) return
    const local = localOf(event.clientX, event.clientY)

    if (drag.mode === 'orbit') {
      // Only coast when the release was recent; holding still and letting go
      // must not fling the scene.
      const age = performance.now() - drag.lastT
      const spin = spinRef.current
      if (age > 100 || Math.hypot(spin.yaw, spin.pitch) < 0.0006) {
        spinRef.current = { yaw: 0, pitch: 0 }
      } else {
        ensureAnimation()
      }
      hoverRef.current = onPick ? endpointAt(local.x, local.y) : null
      schedulePaint()
    }

    if (drag.mode === 'start' || drag.mode === 'goal') {
      // A tap on a marker is not a move. Committing it anyway would run a full
      // 3D search to produce an identical result, which reads as a hitch.
      if (drag.moved < 3) {
        ghostRef.current = null
        schedulePaint()
        return
      }
      const point = pickPoint(local.x, local.y)
      ghostRef.current = null
      // Clear the ghost before the new result lands, otherwise the marker snaps
      // back to the old endpoint for the duration of the search.
      schedulePaint()
      onPick?.(drag.mode, point ?? (drag.mode === 'start' ? start : goal))
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
      const next = zoomTargetRef.current * Math.exp(-event.deltaY * unit * 0.0016)
      zoomTargetRef.current = clamp(next, ZOOM_MIN, ZOOM_MAX)
      homeRef.current = false
      ensureAnimation()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [ensureAnimation])

  const zoomBy = useCallback(
    (factor: number) => {
      zoomTargetRef.current = clamp(zoomTargetRef.current * factor, ZOOM_MIN, ZOOM_MAX)
      homeRef.current = false
      ensureAnimation()
    },
    [ensureAnimation],
  )

  /** Home view. Also bound to double-click, the gesture people try first. */
  const resetView = useCallback(() => {
    spinRef.current = { yaw: 0, pitch: 0 }
    homeRef.current = true
    ensureAnimation()
  }, [ensureAnimation])

  return (
    <div className="scene3d" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className={`scene3d-canvas ${pickMode !== 'none' ? 'is-picking' : ''}`}
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
        <span>{tr(lang, '拖动 S / G 移动端点')}</span>
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
