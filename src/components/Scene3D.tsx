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
  cx: number
  cy: number
  cz: number
  nx: number
  ny: number
  nz: number
  /** Shade index: 0 wall top, 1 side facing +x/+y, 2 side facing -x/-y, 3 floor. */
  shade: 0 | 1 | 2 | 3
}

const PAPER = '#f8f5ed'
/*
 * The floor is its own shade, and that is not decoration.
 *
 * A solid volume is a single material, so the first build gave every upward face
 * the same colour — the ground slab and the tops of the walls. The result read as
 * one grey plate with bumps: no floor to stand on, no height to the blocks, and
 * nothing for the route to sit *above*. Separating the ground（lighter, matte）
 * from what stands on it（darker, cooler）restores the two things the eye needs
 * in an orthographic view: where the ground is, and how tall everything else is.
 */
const FLOOR = '#8f978c'
const WALL_TOP = '#6e766b'
const WALL_SIDE_A = '#535d55'
const WALL_SIDE_B = '#3b433d'
// The path is the one element that must survive every background: it crosses the
// pale floor, then a dark wall's top face, then a wall's shaded side. A single
// flat colour cannot do that — pine on the walls goes to near-black. So the route
// is drawn as a light ribbon with a dark underlay, which reads on all three.
const PATH = '#f7f1e2'
const PATH_LOW = '#c9dccd'
const PATH_HIGH = '#e9b47c'
const PATH_HALO = 'rgba(22, 31, 26, 0.82)'
const START = '#2f5d50'
const GOAL = '#a45f43'
const TRAIL = '52, 78, 66'

interface Bounds {
  min: Vec3
  max: Vec3
}

/** Linear blend between two `#rrggbb` colours. */
function mix(a: string, b: string, t: number): string {
  const channel = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const ca = channel(a)
  const cb = channel(b)
  const at = (i: number) => Math.round(ca[i] + (cb[i] - ca[i]) * t)
  return `rgb(${at(0)}, ${at(1)}, ${at(2)})`
}

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
  const pad = 26
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

/** A cube's four corners for a given axis-aligned face. */
function faceCorners(cx: number, cy: number, cz: number, nx: number, ny: number, nz: number): Vec3[] {
  const x0 = cx
  const y0 = cy
  const z0 = cz
  const x1 = cx + 1
  const y1 = cy + 1
  const z1 = cz + 1
  if (nz !== 0) {
    const z = nz > 0 ? z1 : z0
    return [
      { x: x0, y: y0, z },
      { x: x1, y: y0, z },
      { x: x1, y: y1, z },
      { x: x0, y: y1, z },
    ]
  }
  if (nx !== 0) {
    const x = nx > 0 ? x1 : x0
    return [
      { x, y: y0, z: z0 },
      { x, y: y1, z: z0 },
      { x, y: y1, z: z1 },
      { x, y: y0, z: z1 },
    ]
  }
  const y = ny > 0 ? y1 : y0
  return [
    { x: x0, y, z: z0 },
    { x: x1, y, z: z0 },
    { x: x1, y, z: z1 },
    { x: x0, y, z: z1 },
  ]
}

/** Exposed faces of a voxel volume, computed once per world. */
function buildFaces(cells: Uint8Array, width: number, height: number, depth: number): Face[] {
  const faces: Face[] = []
  const plane = width * height
  const at = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) return 1
    return cells[z * plane + y * width + x]
  }
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (cells[z * plane + y * width + x] !== 1) continue
        // Ground-level upward faces are the floor, not another block's lid.
        if (at(x, y, z + 1) === 0)
          faces.push({ cx: x, cy: y, cz: z, nx: 0, ny: 0, nz: 1, shade: z === 0 ? 3 : 0 })
        if (at(x + 1, y, z) === 0)
          faces.push({ cx: x, cy: y, cz: z, nx: 1, ny: 0, nz: 0, shade: 1 })
        if (at(x - 1, y, z) === 0)
          faces.push({ cx: x, cy: y, cz: z, nx: -1, ny: 0, nz: 0, shade: 2 })
        if (at(x, y + 1, z) === 0)
          faces.push({ cx: x, cy: y, cz: z, nx: 0, ny: 1, nz: 0, shade: 1 })
        if (at(x, y - 1, z) === 0)
          faces.push({ cx: x, cy: y, cz: z, nx: 0, ny: -1, nz: 0, shade: 2 })
        if (at(x, y, z - 1) === 0)
          faces.push({ cx: x, cy: y, cz: z, nx: 0, ny: 0, nz: -1, shade: 2 })
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
  const [yaw, setYaw] = useState(-0.66)
  // 0.98 rad looks almost straight down: the volume flattens into a plan view
  // and dragging it left/right reads like spinning a picture. 0.82 keeps enough
  // side wall visible that the scene has depth, while still showing the layout.
  const [pitch, setPitch] = useState(0.82)
  const [zoom, setZoom] = useState(1)
  const [size, setSize] = useState({ width: 0, height: 0 })
  // An endpoint being dragged is previewed here rather than committed to the
  // planner: a 3D search costs 70–160 ms, so re-planning on every pointermove
  // would turn a drag into a slideshow. The marker follows the cursor, the route
  // stays put until the pointer is released.
  const [ghost, setGhost] = useState<{ which: 'start' | 'goal'; point: Vec3 } | null>(null)
  const dragRef = useRef<{
    mode: 'orbit' | 'start' | 'goal'
    x: number
    y: number
    yaw: number
    pitch: number
    /** Screen pixels travelled so far — decides click vs drag. */
    moved: number
    pick: 'none' | 'start' | 'goal'
  } | null>(null)
  /** The exact transform the last frame was drawn with, reused for hit-testing. */
  const frameRef = useRef<ReturnType<typeof fitView> | null>(null)

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

  const project = useCallback(
    (p: Vec3, scale: number, originX: number, originY: number, cy: number, sy: number, cp: number, sp: number) => {
      const rx = p.x * cy + p.y * sy
      const ry = -p.x * sy + p.y * cy
      return {
        x: originX + rx * scale,
        y: originY - (ry * sp + p.z * cp) * scale,
        depth: ry * cp - p.z * sp,
      }
    },
    [],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width === 0 || size.height === 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)

    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    const { bounds } = geometry

    // Fit the projected bounding box into the viewport, then apply user zoom.
    const frame = fitView(bounds, size.width, size.height, yaw, pitch, zoom)
    const { scale, originX, originY } = frame
    // Remembered so pointer maths uses the frame that is actually on screen.
    frameRef.current = frame

    const projectPoint = (p: Vec3) => project(p, scale, originX, originY, cy, sy, cp, sp)

    // Paper, with a barely-there vignette so the scene sits in the surface.
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, size.width, size.height)

    // Ground grid on the world's floor plane.
    const floorZ = bounds.min.z
    ctx.strokeStyle = 'rgba(64, 68, 58, 0.09)'
    ctx.lineWidth = 1
    const step = 5
    ctx.beginPath()
    for (let x = Math.ceil(bounds.min.x / step) * step; x <= bounds.max.x; x += step) {
      const a = projectPoint({ x, y: bounds.min.y, z: floorZ })
      const b = projectPoint({ x, y: bounds.max.y, z: floorZ })
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    }
    for (let y = Math.ceil(bounds.min.y / step) * step; y <= bounds.max.y; y += step) {
      const a = projectPoint({ x: bounds.min.x, y, z: floorZ })
      const b = projectPoint({ x: bounds.max.x, y, z: floorZ })
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    }
    ctx.stroke()

    const items: DrawItem[] = []

    // Voxel walls: only faces turned toward the camera.
    const towardCamera = { x: sy * cp, y: -cy * cp, z: sp }
    for (const face of geometry.faces) {
      const dot = face.nx * towardCamera.x + face.ny * towardCamera.y + face.nz * towardCamera.z
      if (dot <= 0.001) continue
      const corners = faceCorners(face.cx, face.cy, face.cz, face.nx, face.ny, face.nz)
      const pts = corners.map(projectPoint)
      let depth = 0
      for (const p of pts) depth += p.depth
      depth /= pts.length
      const fill = shadeFill(face.shade)
      items.push({
        depth,
        draw: (c) => {
          c.fillStyle = fill
          c.strokeStyle = fill
          c.lineWidth = 1
          c.beginPath()
          c.moveTo(pts[0].x, pts[0].y)
          for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i].x, pts[i].y)
          c.closePath()
          c.fill()
          c.stroke()
        },
      })
    }

    // Analytic primitives.
    for (const primitive of geometry.primitives) {
      if (primitive.kind === 'disc') {
        const c = projectPoint({ x: primitive.x, y: primitive.y, z: floorZ })
        const r = primitive.r * scale
        items.push({
          depth: projectPoint({ x: primitive.x, y: primitive.y, z: floorZ }).depth,
          draw: (ctx2) => {
            ctx2.fillStyle = WALL_SIDE_A
            ctx2.beginPath()
            // A disc on the ground plane is an ellipse once tilted.
            ctx2.ellipse(c.x, c.y, r, Math.max(1, r * sp), 0, 0, Math.PI * 2)
            ctx2.fill()
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
          draw: (ctx2) => {
            ctx2.fillStyle = WALL_SIDE_A
            ctx2.beginPath()
            ctx2.moveTo(pts[0].x, pts[0].y)
            for (let i = 1; i < 4; i += 1) ctx2.lineTo(pts[i].x, pts[i].y)
            ctx2.closePath()
            ctx2.fill()
          },
        })
        continue
      }
      if (primitive.kind === 'capsule' && geometry.dim === 2) {
        const a = projectPoint({ x: primitive.ax, y: primitive.ay, z: floorZ })
        const b = projectPoint({ x: primitive.bx, y: primitive.by, z: floorZ })
        const w = Math.max(1, primitive.r * 2 * scale * sp)
        items.push({
          depth: (a.depth + b.depth) / 2,
          draw: (ctx2) => {
            ctx2.strokeStyle = WALL_SIDE_A
            ctx2.lineWidth = w
            ctx2.lineCap = 'round'
            ctx2.beginPath()
            ctx2.moveTo(a.x, a.y)
            ctx2.lineTo(b.x, b.y)
            ctx2.stroke()
          },
        })
        continue
      }
      if (primitive.kind === 'sphere') {
        const p = projectPoint({ x: primitive.x, y: primitive.y, z: primitive.z })
        const r = primitive.r * scale
        items.push({
          depth: p.depth,
          draw: (ctx2) => {
            const g = ctx2.createRadialGradient(
              p.x - r * 0.35,
              p.y - r * 0.4,
              r * 0.1,
              p.x,
              p.y,
              r,
            )
            g.addColorStop(0, WALL_TOP)
            g.addColorStop(1, WALL_SIDE_B)
            ctx2.fillStyle = g
            ctx2.beginPath()
            ctx2.arc(p.x, p.y, r, 0, Math.PI * 2)
            ctx2.fill()
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
          draw: (ctx2) => {
            ctx2.strokeStyle = WALL_SIDE_A
            ctx2.lineWidth = w
            ctx2.lineCap = 'round'
            ctx2.beginPath()
            ctx2.moveTo(a.x, a.y)
            ctx2.lineTo(b.x, b.y)
            ctx2.stroke()
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
          const pts = face.c.map(projectPoint)
          let depth = 0
          for (const p of pts) depth += p.depth
          const fill = shadeFill(face.shade)
          items.push({
            depth: depth / 4,
            draw: (ctx2) => {
              ctx2.fillStyle = fill
              ctx2.strokeStyle = fill
              ctx2.lineWidth = 1
              ctx2.beginPath()
              ctx2.moveTo(pts[0].x, pts[0].y)
              for (let i = 1; i < pts.length; i += 1) ctx2.lineTo(pts[i].x, pts[i].y)
              ctx2.closePath()
              ctx2.fill()
              ctx2.stroke()
            },
          })
        }
      }
    }

    // Search trail.
    //
    // Two things have to happen before these marks are readable.
    //
    // First, collapse to one mark per *cell*. The search expands states, not
    // voxels: a cell is reached once per incoming direction, so the event list
    // holds up to 27 entries per voxel. Plotting them all repaints the same
    // floor cell again and again — the voxel scene turns into a solid dark
    // carpet and the path drowns in it. One mark per cell, faded by how early
    // it was touched, reads as "this is the volume the search swept".
    //
    // Second, keep the mark small — and solve for its alpha instead of guessing.
    //
    // A trail is not a set of independent marks: in a 3D volume many touched
    // cells land behind the same pixel, so opacity accumulates along the view
    // ray. A constant alpha that looks like a light wash in a flat 2D field
    // (eight hundred cells, one layer) becomes a white cloud in a swept volume
    // (seven thousand cells, ten layers) — and the cloud swallows both the
    // geometry and the route.
    //
    // So: measure the average stack depth (cells × mark area ÷ footprint) and
    // choose the per-mark alpha that composites to a fixed, gentle target. That
    // is one line of maths and it holds for every world.
    if (showExpanded && result) {
      const visible = Math.max(0, Math.min(playhead, result.events.length))
      const completed = visible >= result.events.length
      const seen = new Map<number, number>()
      for (let i = 0; i < visible; i += 1) {
        const event = result.events[i]
        const key =
          (Math.round(event.x * 2) * 256 + Math.round(event.y * 2)) * 256 + Math.round((event.z ?? 0) * 2)
        if (!seen.has(key)) seen.set(key, i)
      }
      const marks = [...seen.values()].map((i) => {
        const event = result.events[i]
        const p = projectPoint({ x: event.x, y: event.y, z: event.z ?? 0 })
        return { p, phase: Math.min(1, (i + 1) / Math.max(1, visible)) }
      })
      if (marks.length > 0) {
        // Cap the *number* of marks rather than tuning alpha against the count.
        // Density is what cannot be controlled per mark: twenty thousand cells in
        // one viewport is a wash however faint each one is, while two thousand is
        // a stipple you can read as individual expansions. Striding the list keeps
        // the coverage even, because it is ordered by first touch.
        const stride = Math.max(1, Math.ceil(marks.length / 1400))
        const dot = Math.max(1, Math.min(3, scale * 0.24))
        const alpha = completed ? 0.11 : 0.3
        for (let i = 0; i < marks.length; i += stride) {
          const mark = marks[i]
          // Recently expanded marks are darker: that is the search's leading edge.
          const ink = alpha * (0.45 + 0.55 * mark.phase)
          items.push({
            depth: mark.p.depth,
            draw: (ctx2) => {
              ctx2.fillStyle = `rgba(${TRAIL}, ${ink})`
              ctx2.fillRect(mark.p.x - dot / 2, mark.p.y - dot / 2, dot, dot)
            },
          })
        }
      }
    }

    // Path, one segment at a time so walls can occlude it correctly.
    //
    // Colour encodes altitude. On a top-down-ish camera an orthographic picture
    // has no perspective cue for height: a climb and a walk read identically.
    // Tinting the route from pale sage (low) through cream to amber (high) puts
    // the vertical component back without adding chrome such as drop lines or a
    // second axis.
    let route: { x: number; y: number }[] = []
    let routeWidth = 2
    if (showPath && result && result.path3 && result.path3.length > 1) {
      const total = result.path3.length
      const visible = Math.max(0, Math.min(playhead, result.events.length))
      const grown = result.events.length === 0 ? total : Math.max(2, Math.round((visible / result.events.length) * total))
      const pts = result.path3.slice(0, grown).map(projectPoint)
      const width = Math.max(3, scale * 0.22)
      let lowZ = Infinity
      let highZ = -Infinity
      for (const p of result.path3) {
        if (p.z < lowZ) lowZ = p.z
        if (p.z > highZ) highZ = p.z
      }
      const span = Math.max(1e-6, highZ - lowZ)
      const lift = (z: number) => {
        const t = Math.max(0, Math.min(1, (z - lowZ) / span))
        if (t < 0.5) return mix(PATH_LOW, PATH, t * 2)
        return mix(PATH, PATH_HIGH, (t - 0.5) * 2)
      }
      route = pts
      routeWidth = width
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1]
        const b = pts[i]
        const tint = lift((result.path3[i].z + result.path3[i - 1].z) / 2)
        items.push({
          depth: (a.depth + b.depth) / 2,
          draw: (ctx2) => {
            ctx2.lineCap = 'round'
            ctx2.beginPath()
            ctx2.moveTo(a.x, a.y)
            ctx2.lineTo(b.x, b.y)
            ctx2.strokeStyle = PATH_HALO
            ctx2.lineWidth = width + 2.6
            ctx2.stroke()
            ctx2.strokeStyle = tint
            ctx2.lineWidth = width
            ctx2.stroke()
          },
        })
      }
    }

    items.sort((a, b) => b.depth - a.depth)
    for (const item of items) item.draw(ctx)

    // X-ray pass.
    //
    // Occlusion is the honest default and it is what makes the columns read as
    // solid. But when the goal happens to sit behind one, the route simply stops
    // mid-air and the first thing a viewer concludes is "the planner failed".
    // A translucent repeat of the whole route restores the continuity without
    // pretending: behind a wall the line is a ghost, in the open it is so faint
    // that it only brightens the crisp ribbon already drawn.
    //
    // Deliberately *not* dashed. A dash pattern reads as a second, competing
    // route — on a mostly-visible path it turned the whole route into a dotted
    // line. A solid low-alpha repeat has no rhythm of its own.
    if (route.length > 1) {
      ctx.save()
      ctx.strokeStyle = 'rgba(247, 241, 226, 0.28)'
      ctx.lineWidth = Math.max(1, routeWidth * 0.5)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(route[0].x, route[0].y)
      for (let i = 1; i < route.length; i += 1) ctx.lineTo(route[i].x, route[i].y)
      ctx.stroke()
      ctx.restore()
    }

    // Endpoints: last, unsorted, because they are controls rather than geometry.
    //
    // They share the route's language on purpose — same round cap, same stroke
    // weight, plus a short leader from the marker to the first/last vertex. In a
    // field world the stored endpoint and the nearest lattice centre differ by up
    // to half a cell, and without that leader the route visibly fails to reach its
    // own start point, which reads as "the markers and the path don't belong to
    // each other".
    // Derived from the route width, not from the viewport scale: a marker that
    // keeps its own size while the line thickens is the "two visual systems"
    // problem, and it is the reason S/G looked pasted on.
    const markerRadius = Math.max(6.5, Math.min(13, routeWidth * 2.2))
    const drawMarker = (point: Vec3, color: string, label: string, live: boolean) => {
      const p = projectPoint(point)
      if (live) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, markerRadius + 6, 0, Math.PI * 2)
        ctx.fillStyle = label === 'S' ? 'rgba(47,93,80,0.14)' : 'rgba(164,95,67,0.14)'
        ctx.fill()
      }
      ctx.beginPath()
      ctx.arc(p.x, p.y, markerRadius + 2, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(250,247,239,0.95)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(p.x, p.y, markerRadius, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(28,36,31,0.36)'
      ctx.stroke()
      ctx.fillStyle = '#fdfcf8'
      ctx.font = `700 ${Math.max(9, markerRadius * 0.95)}px "Cascadia Mono", ui-monospace, monospace`
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
        ctx.lineWidth = routeWidth + 2.6
        ctx.stroke()
        ctx.strokeStyle = PATH
        ctx.lineWidth = routeWidth
        ctx.stroke()
      }
      leader(startAt, route[0])
      leader(goalAt, route[route.length - 1])
    }

    drawMarker(startAt, START, 'S', ghost?.which === 'start' || pickMode === 'start')
    drawMarker(goalAt, GOAL, 'G', ghost?.which === 'goal' || pickMode === 'goal')

    if (pickMode !== 'none') {
      ctx.strokeStyle = pickMode === 'start' ? 'rgba(47,93,80,0.5)' : 'rgba(164,95,67,0.5)'
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 1
      ctx.strokeRect(1, 1, size.width - 2, size.height - 2)
      ctx.setLineDash([])
    }
  }, [geometry, result, start, goal, playhead, showExpanded, showPath, yaw, pitch, zoom, size, pickMode, ghost, project])

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
   * the first solid cell, returning the free sample just in front of it: the
   * surface the user actually pointed at.
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
    const rx = point.x * frame.cy + point.y * frame.sy
    const ry = -point.x * frame.sy + point.y * frame.cy
    return {
      x: frame.originX + rx * frame.scale,
      y: frame.originY - (ry * frame.sp + point.z * frame.cp) * frame.scale,
    }
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
    let bestDistance = 17
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

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    canvasRef.current?.setPointerCapture?.(event.pointerId)
    const local = localOf(event.clientX, event.clientY)

    // Grabbing S or G outranks everything: in the 2D canvas the markers are
    // draggable at all times, and having to arm a mode first is exactly the kind
    // of asymmetry that makes a view feel like a different application.
    const grabbed = onPick ? endpointAt(local.x, local.y) : null
    dragRef.current = {
      mode: grabbed ?? 'orbit',
      x: event.clientX,
      y: event.clientY,
      yaw,
      pitch,
      moved: 0,
      pick: pickMode,
    }
    if (grabbed) {
      setGhost({ which: grabbed, point: grabbed === 'start' ? start : goal })
      canvasRef.current!.style.cursor = 'grabbing'
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const local = localOf(event.clientX, event.clientY)
    const drag = dragRef.current
    if (!drag) {
      // Say "this is draggable" before the user has to discover it.
      const canvas = canvasRef.current
      // `move`, not `grab`: the background is already grab (it orbits), so the
      // marker has to advertise a different, more specific action.
      if (canvas) canvas.style.cursor = endpointAt(local.x, local.y) ? 'move' : ''
      return
    }
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy))

    if (drag.mode === 'orbit') {
      // "Grab the scene" semantics: drag right and the volume swings right, which
      // means yaw *decreases* — yaw is the camera's bearing around the scene, not
      // the scene's rotation about the camera. The opposite sign is why the view
      // felt like it was fighting the hand.
      setYaw(drag.yaw - dx * 0.0075)
      setPitch(Math.max(0.14, Math.min(1.42, drag.pitch + dy * 0.0055)))
      return
    }

    const point = pickPoint(local.x, local.y)
    if (point) setGhost({ which: drag.mode, point })
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = ''
    if (!drag) return
    const local = localOf(event.clientX, event.clientY)

    if (drag.mode === 'start' || drag.mode === 'goal') {
      // A tap on a marker is not a move. Committing it anyway would run a full
      // 3D search to produce an identical result, which reads as a hitch.
      if (drag.moved < 3) {
        setGhost(null)
        return
      }
      const point = pickPoint(local.x, local.y)
      onPick?.(drag.mode, point ?? (drag.mode === 'start' ? start : goal))
      setGhost(null)
      return
    }

    // A press that never moved is a click: in pick mode it places the point.
    // Treating it as a drag (the old behaviour) made "click the floor" and
    // "orbit the view" the same gesture, so every click also nudged the camera.
    if (drag.pick !== 'none' && drag.moved < 5) {
      const point = pickPoint(local.x, local.y)
      if (point) onPick?.(drag.pick, point)
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
      const step = event.deltaY > 0 ? 0.92 : 1.08
      setZoom((value) => Math.max(0.6, Math.min(3.4, value * step)))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  /** Home view. Also bound to double-click, the gesture people try first. */
  const resetView = useCallback(() => {
    setYaw(-0.66)
    setPitch(0.82)
    setZoom(1)
  }, [])

  return (
    <div className="scene3d" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className={`scene3d-canvas ${pickMode !== 'none' ? 'is-picking' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={resetView}
      />
      <div className="scene3d-hint">
        <span>{tr(lang, '拖动旋转')}</span>
        <span>{tr(lang, '滚轮缩放')}</span>
        <span>{tr(lang, '拖动 S / G 移动端点')}</span>
      </div>
      <div className="scene3d-zoom">
        <button type="button" title={tr(lang, '放大')} onClick={() => setZoom((v) => Math.min(3.4, v * 1.12))}>
          +
        </button>
        <button type="button" title={tr(lang, '缩小')} onClick={() => setZoom((v) => Math.max(0.6, v / 1.12))}>
          −
        </button>
        <button type="button" title={tr(lang, '复位视角')} onClick={resetView}>
          ⟲
        </button>
      </div>
    </div>
  )
}
