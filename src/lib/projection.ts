/**
 * The axonometric camera, in both directions.
 *
 * This lives outside the component for one reason: picking has to invert
 * exactly what the renderer draws, and the only way to keep two copies of a
 * transform honest is to stop having two copies. Everything here is pure —
 * no canvas, no React — so `scripts/pick.ts` can round-trip it in Node and fail
 * the build when the forward and inverse passes drift apart.
 *
 * They did drift apart once. The forward pass multiplies z by `Z_LIFT` (the
 * vertical exaggeration that makes one-cell walls readable); the inverse did
 * not. On the floor that is invisible, which is why it survived: the error is
 * `z · cot(pitch) · (Z_LIFT − 1)` cells deep — 0.19 cells at the first storey
 * and growing with altitude. The symptom was "I drag it here and it lands
 * there", and no amount of snapping or easing hides a constant offset, because
 * the marker and the result disagreed by construction.
 */
import type { Vec3 } from './core/space'

/**
 * Vertical exaggeration.
 *
 * The voxel volumes are one cell tall. At true isometric proportion a one-cell
 * wall shows its top face as a sliver, so a room reads as cardboard cut-outs
 * standing on a plate. Real isometric art cheats this: stretch the z axis and
 * the same cells become walls with a readable top, a readable side, and a
 * shadow between them. 1.22 is enough to give the volume a face without tipping
 * into "tall building".
 */
export const Z_LIFT = 1.22

export interface Bounds {
  min: Vec3
  max: Vec3
}

export interface CameraFrame {
  scale: number
  originX: number
  originY: number
  cy: number
  sy: number
  cp: number
  sp: number
}

/**
 * The camera fit — one transform, used by both the renderer and by picking.
 *
 * `panX` / `panY` are a screen-space nudge applied after the fit. They exist
 * because "zoom toward the cursor" is a translation as well as a scale: holding
 * the point under the pointer still means moving the picture when the scale
 * changes. Keeping the pan in the frame (rather than in every call site) means
 * picking, drawing and hit-testing all see the same picture by construction.
 */
export function fitView(
  bounds: Bounds,
  width: number,
  height: number,
  yaw: number,
  pitch: number,
  zoom: number,
  panX = 0,
  panY = 0,
): CameraFrame {
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
    const py = -(ry * sp + z * Z_LIFT * cp)
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
    originX: width / 2 - ((minX + maxX) / 2) * scale + panX,
    originY: height / 2 - ((minY + maxY) / 2) * scale + panY,
    cy,
    sy,
    cp,
    sp,
  }
}

/** Project one world point through a frame. Also returns its sort depth. */
export function projectIn(frame: CameraFrame, p: Vec3) {
  const rx = p.x * frame.cy + p.y * frame.sy
  const ry = -p.x * frame.sy + p.y * frame.cy
  const z = p.z * Z_LIFT
  return {
    x: frame.originX + rx * frame.scale,
    y: frame.originY - (ry * frame.sp + z * frame.cp) * frame.scale,
    depth: ry * frame.cp - z * frame.sp,
  }
}

/** Screen → world, on the plane z = `planeZ`. The exact inverse of `projectIn`. */
export function unprojectIn(
  frame: CameraFrame,
  x: number,
  y: number,
  planeZ: number,
): Vec3 {
  const rx = (x - frame.originX) / frame.scale
  const wy = -(y - frame.originY) / frame.scale
  const ry = (wy - planeZ * Z_LIFT * frame.cp) / Math.max(1e-6, frame.sp)
  return { x: rx * frame.cy - ry * frame.sy, y: rx * frame.sy + ry * frame.cy, z: planeZ }
}

/**
 * Direction that leaves the screen position unchanged: the view ray, in world
 * units per unit of z.
 *
 * Solving `d(projectIn) = 0` for z = 1 gives `k = −Z_LIFT·cp/sp` along the
 * in-plane perpendicular, so the ray leans by `Z_LIFT·cot(pitch)` — the same
 * factor the inverse above needs, because it is the same equation.
 */
export function viewRay(frame: CameraFrame): Vec3 {
  const k = (Z_LIFT * frame.cp) / Math.max(1e-6, frame.sp)
  return { x: k * frame.sy, y: -k * frame.cy, z: 1 }
}
