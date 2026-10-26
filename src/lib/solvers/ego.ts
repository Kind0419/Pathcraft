/**
 * EGO-Planner — an ESDF-free gradient-based local planner.
 *
 * A direct implementation of
 *   Xin Zhou, Zhepei Wang, Hongkai Ye, Chao Xu, Fei Gao,
 *   "EGO-Planner: An ESDF-free Gradient-based Local Planner for Quadrotors",
 *   IEEE RA-L 6(2):478–485, 2021.  arXiv:2008.08835
 *
 * Every formula below cites the equation it comes from, because the whole
 * argument of the paper is in the details:
 *
 *  1. **No distance field.** The collision term is built from `{p, v}` pairs
 *     (Sec. III, Fig. 3). For a control point whose span has hit something, a
 *     collision-free guide path Γ is searched; `p` is the anchor next to the
 *     obstacle surface, `v` is the unit outward direction there. The obstacle
 *     distance is the *plane* distance `d = (Q − p)·v` (Eq. 1) — a linear field
 *     with a constant gradient `v`, which is all a gradient-based planner ever
 *     needs. Nothing is precomputed, so an obstacle is only ever "discovered" by
 *     the trajectory that touches it.
 *  2. **Pairs persist.** A pair is only refreshed once the point has left that
 *     obstacle (`d > 0` for every stored pair, Alg. 1). During the first
 *     iterations the trajectory therefore *rebounds* between obstacles with the
 *     same forces instead of re-querying the world — that is where the speed
 *     comes from, and it is what the while-loop of Alg. 2 draws.
 *  3. **The penalty is piecewise cubic, not quadratic** (Eq. 5):
 *        j_c = 0                          c ≤ 0
 *        j_c = c³                         0 < c ≤ s_f
 *        j_c = 3s_f c² − 3s_f² c + s_f³   c > s_f
 *     with `c = s_f − d`. The slope is suppressed as the point approaches the
 *     boundary, which is what makes the cost twice continuously differentiable.
 *  4. **The gradient is the direction `v`, scaled** (Eq. 7) — never a trilinear
 *     interpolation of a field.
 *  5. **Feasibility is not a gradient term.** It is the ratio in Eq. 14
 *     (`|v|/v_max`, `√(|a|/a_max)`, `∛(|j|/j_max)`) applied to Δt.
 *
 * Deliberate, documented differences from the paper:
 *
 *  - **The guide path Γ.** The paper runs A* from the colliding segment to free
 *    space. Here `p` is the nearest legal cell centre around the colliding
 *    sample — the same point on the same surface within half a cell — which
 *    keeps one ring search per stuck point instead of a search per segment. The
 *    plane Ψ of Fig. 3b is skipped for the same reason.
 *  - **The refinement of Sec. V.** Δt is stretched exactly as Eq. 14/15 say, but
 *    the anisotropic curve-fitting re-optimisation (Eq. 16–18) is not run. The
 *    shape is therefore preserved exactly, which is the property the film
 *    depends on and the property the UI note states.
 *  - **The seed.** The paper starts from a naive B-spline that ignores
 *    collisions and lets the planner rebound out; that seed is tried first here
 *    too. When a scene is tight enough that the rebound cannot finish, the
 *    solver retries from a collision-free front-end path and keeps whichever
 *    answer is feasible. The paper's Alg. 2 gets the same second chance from
 *    `FindInit(Q_last, G)` in a receding-horizon loop.
 */
import type { CardId, CardsState, GridMap, PlanResult, Point, SearchEvent, SpaceKind } from '../types'
import { lengthScale, safetyRadius } from '../core/costs'
import { gridLattice, type Lattice, type Vec3 } from '../core/space'
import { searchLattice } from './generic'
import { buildLattice, type LatticePlanInput } from './lattice3d'
import type { SolverSpec } from './registry'
import { tunedValue } from './shared'

/* ------------------------------------------------------------------ oracle -- */

export interface EgoOracle {
  dim: 2 | 3
  /** Lattice cell size in world units. All pads below are in lattice units. */
  spacing: number
  bounds: { min: Vec3; max: Vec3 }
  /** Legal at `pad` lattice units away from any obstacle. */
  free(point: Vec3, pad: number): boolean
  segmentFree(a: Vec3, b: Vec3, pad: number): boolean
  clearanceAt(point: Vec3): number
  /**
   * Closest legal point, searched outwards one cell shell at a time.
   *
   * This is the whole "don't build a field" argument in one function: a local
   * query that gets more expensive the further the point is from air, returning
   * `null` rather than a number when there is nothing within reach. Only points
   * that have actually hit something ever pay for it.
   */
  nearestFree(point: Vec3, pad: number): Vec3 | null
  /** Cells inspected by `nearestFree` so far — the film's cost figure. */
  probes(): number
}

/**
 * Build an oracle over a lattice.
 *
 * Cell centres are the only candidates, which keeps the anchor on the grid the
 * renderer draws. The ring search widens to `reach` shells; past that the point
 * is treated as unreachable — a control point buried in a two-metre column has
 * no cheap answer, and inventing one would drag the curve through the wall.
 */
export function oracleFromLattice(lattice: Lattice, padWorld: number, reach = 8): EgoOracle {
  const { spacing, width, height, depth, metric } = lattice
  const dim = lattice.dim

  let probes = 0
  const cache = new Map<number, Vec3 | null>()

  const centre = (x: number, y: number, z: number): Vec3 => ({
    x: x * spacing + spacing * 0.5,
    y: y * spacing + spacing * 0.5,
    z: dim === 3 ? z * spacing + spacing * 0.5 : 0,
  })

  const free = (p: Vec3, pad: number) => metric.free(p, pad * spacing)

  const nearestFree = (p: Vec3, pad: number): Vec3 | null => {
    const ix = Math.floor(p.x / spacing)
    const iy = Math.floor(p.y / spacing)
    const iz = dim === 3 ? Math.floor(p.z / spacing) : 0
    const key =
      ((iz + 1) * 4096 + (iy + 1) * 128 + (ix + 1)) * 32 + Math.min(31, Math.round(pad))
    const hit = cache.get(key)
    if (hit !== undefined) return hit ? { ...hit } : null

    const maxShell = dim === 3 ? reach : Math.max(reach, 10)
    for (let r = 0; r <= maxShell; r += 1) {
      const zlo = dim === 3 ? -r : 0
      const zhi = dim === 3 ? r : 0
      for (let dz = zlo; dz <= zhi; dz += 1) {
        for (let dy = -r; dy <= r; dy += 1) {
          for (let dx = -r; dx <= r; dx += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
            const x = ix + dx
            const y = iy + dy
            const z = iz + dz
            if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) continue
            probes += 1
            const point = centre(x, y, z)
            if (free(point, pad)) {
              cache.set(key, point)
              return { ...point }
            }
          }
        }
      }
    }
    cache.set(key, null)
    return null
  }

  return {
    dim,
    spacing,
    bounds: metric.bounds,
    free,
    segmentFree: (a, b, pad) => metric.segmentFree(a, b, pad * spacing),
    clearanceAt: (p) => metric.clearanceAt(p) / spacing,
    nearestFree,
    probes: () => probes,
  }
}

/* ------------------------------------------------------------- B-spline ----- */

/** Uniform cubic basis at local parameter t. */
function basis(t: number): [number, number, number, number] {
  const t2 = t * t
  const t3 = t2 * t
  const u = 1 - t
  return [
    (u * u * u) / 6,
    (3 * t3 - 6 * t2 + 4) / 6,
    (-3 * t3 + 3 * t2 + 3 * t + 1) / 6,
    t3 / 6,
  ]
}

/**
 * Control array with the ends tripled.
 *
 * A uniform cubic B-spline does not pass through its control points. Tripling
 * the first and last one makes the curve start exactly at S and end exactly at G
 * — at t = 0 the basis is (1,4,1)/6 acting on three identical points — which is
 * the cheapest way to honour terminal constraints without clamped knots.
 */
function withFixedEnds(inner: Vec3[], start: Vec3, goal: Vec3): Vec3[] {
  return [
    { ...start },
    { ...start },
    { ...start },
    ...inner.map((p) => ({ ...p })),
    { ...goal },
    { ...goal },
    { ...goal },
  ]
}

function curveLength(points: Vec3[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
      points[i].z - points[i - 1].z,
    )
  }
  return total
}

/** Uniform resample of a polyline into `count` points, endpoints included. */
function resample(polyline: Vec3[], count: number): Vec3[] {
  const n = Math.max(2, count)
  if (polyline.length === 0) return []
  if (polyline.length === 1) return Array.from({ length: n }, () => ({ ...polyline[0] }))
  const cumulative: number[] = [0]
  for (let i = 1; i < polyline.length; i += 1) {
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot(
          polyline[i].x - polyline[i - 1].x,
          polyline[i].y - polyline[i - 1].y,
          polyline[i].z - polyline[i - 1].z,
        ),
    )
  }
  const total = cumulative[cumulative.length - 1]
  if (total < 1e-9) return Array.from({ length: n }, () => ({ ...polyline[0] }))
  const out: Vec3[] = []
  let cursor = 0
  for (let i = 0; i < n; i += 1) {
    const target = (i / (n - 1)) * total
    while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < target) cursor += 1
    const span = cumulative[cursor + 1] - cumulative[cursor]
    const t = span < 1e-9 ? 0 : (target - cumulative[cursor]) / span
    out.push({
      x: polyline[cursor].x + (polyline[cursor + 1].x - polyline[cursor].x) * t,
      y: polyline[cursor].y + (polyline[cursor + 1].y - polyline[cursor].y) * t,
      z: polyline[cursor].z + (polyline[cursor + 1].z - polyline[cursor].z) * t,
    })
  }
  return out
}

export interface EgoConfig {
  /** Interior control points. The control array is `controlPoints + 6` long. */
  controlPoints: number
  /** Lattice units per second (paper: v_max). */
  maxSpeed: number
  /** Lattice units per second² (paper: a_max). */
  maxAccel: number
  /** Lattice units per second³ (paper: j_max). */
  maxJerk: number
  /** λ_s in Eq. 3. */
  lambdaSmooth: number
  /** λ_c in Eq. 3. */
  lambdaCollision: number
  /** Safety clearance s_f in Eq. 5, in lattice units. */
  safety: number
  maxIterations: number
  /** Curve samples per span used only to *detect* collisions. */
  samplesPerSegment: number
}

export const EGO_DEFAULTS: EgoConfig = {
  controlPoints: 9,
  maxSpeed: 2.4,
  maxAccel: 6,
  maxJerk: 20,
  lambdaSmooth: 1,
  lambdaCollision: 100,
  safety: 2,
  maxIterations: 60,
  samplesPerSegment: 6,
}

/** One `{p, v}` pair from Sec. III. `p` sits on the obstacle, `v` points out. */
export interface EgoAnchor {
  /** Index into the distinct control-point array (0 = start). */
  index: number
  /** Anchor next to the obstacle surface, taken from the guide path. */
  p: Vec3
  /** Unit repulsive direction at that anchor. */
  v: Vec3
}

export interface EgoSolution {
  control: Vec3[]
  curve: Vec3[]
  initialCurve: Vec3[]
  segments: number
  /** Seconds per knot span after Eq. 15. */
  dt: number
  duration: number
  js: number
  jc: number
  jd: number
  cost: number
  iterations: number
  history: Array<{ js: number; jc: number; jd: number; cost: number }>
  /** Pairs alive at the end — the "stuck points" of the film. */
  anchors: EgoAnchor[]
  /** Pairs from the first discovery pass, kept for the before/after shot. */
  firstAnchors: EgoAnchor[]
  speed: number[]
  accel: number[]
  jerk: number[]
  speedBefore: number[]
  maxSpeed: number
  maxAccel: number
  maxJerk: number
  maxSpeedBefore: number
  probes: number
  /** Curve samples still inside an obstacle at the end. */
  violations: number
  minClearance: number
  converged: boolean
  dtBefore: number
  dtAfter: number
  /** Eq. 14's exceed ratio; 1 means no reallocation was needed. */
  ratio: number
  /** How many discovery passes the while-loop of Alg. 2 needed. */
  rebounds: number
  /** Which seed won: the paper's naive spline, or the front-end fallback. */
  seed: 'naive' | 'front-end'
}

interface Evaluation {
  js: number
  jc: number
  curve: Vec3[]
  control: Vec3[]
  /** ∂J_s/∂Q, unweighted. */
  gradS: Float64Array
  /** ∂J_c/∂Q, unweighted. */
  gradC: Float64Array
  minClearance: number
}

/** Eq. 5. */
function collisionPenalty(c: number, sf: number): number {
  if (c <= 0) return 0
  if (c <= sf) return c * c * c
  return 3 * sf * c * c - 3 * sf * sf * c + sf * sf * sf
}

/** d(j_c)/d(c) — the bracket in Eq. 7. */
function collisionSlope(c: number, sf: number): number {
  if (c <= 0) return 0
  if (c <= sf) return 3 * c * c
  return 6 * sf * c - 3 * sf * sf
}

/**
 * Evaluate the objective at a control polygon.
 *
 * J_s (Eq. 4) comes from the control points directly. J_c (Eq. 5–7) is summed
 * over the stored `{p, v}` pairs, *not* over sampled curve points: that is the
 * paper's formulation, and it is why the collision gradient has one fixed
 * direction per pair instead of following a field.
 */
function evaluate(
  inner: Vec3[],
  start: Vec3,
  goal: Vec3,
  cfg: EgoConfig,
  oracle: EgoOracle,
  anchors: EgoAnchor[],
): Evaluation {
  const control = withFixedEnds(inner, start, goal)
  const n = control.length
  const segments = n - 3
  const dim = oracle.dim
  const m = inner.length
  const gradS = new Float64Array(m * 3)
  const gradC = new Float64Array(m * 3)

  /* --- J_s, Eq. 4 -------------------------------------------------------- */
  let js = 0
  for (let i = 1; i + 1 < n; i += 1) {
    const ax = control[i + 1].x - 2 * control[i].x + control[i - 1].x
    const ay = control[i + 1].y - 2 * control[i].y + control[i - 1].y
    const az = dim === 3 ? control[i + 1].z - 2 * control[i].z + control[i - 1].z : 0
    js += ax * ax + ay * ay + az * az
    for (let k = -1; k <= 1; k += 1) {
      const index = i + k - 3
      if (index < 0 || index >= m) continue
      const w = (k === 0 ? -2 : 1) * 2
      gradS[index * 3] += w * ax
      gradS[index * 3 + 1] += w * ay
      if (dim === 3) gradS[index * 3 + 2] += w * az
    }
  }
  for (let i = 1; i + 2 < n; i += 1) {
    const jx = control[i + 2].x - 3 * control[i + 1].x + 3 * control[i].x - control[i - 1].x
    const jy = control[i + 2].y - 3 * control[i + 1].y + 3 * control[i].y - control[i - 1].y
    const jz =
      dim === 3
        ? control[i + 2].z - 3 * control[i + 1].z + 3 * control[i].z - control[i - 1].z
        : 0
    js += jx * jx + jy * jy + jz * jz
    const weights = [-1, 3, -3, 1]
    for (let k = -1; k <= 2; k += 1) {
      const index = i + k - 3
      if (index < 0 || index >= m) continue
      const w = weights[k + 1] * 2
      gradS[index * 3] += w * jx
      gradS[index * 3 + 1] += w * jy
      if (dim === 3) gradS[index * 3 + 2] += w * jz
    }
  }

  /* --- J_c, Eq. 1 / 5 / 6 / 7 -------------------------------------------- */
  let jc = 0
  for (const anchor of anchors) {
    const q = control[anchor.index + 2]
    if (!q) continue
    const d =
      (q.x - anchor.p.x) * anchor.v.x +
      (q.y - anchor.p.y) * anchor.v.y +
      (dim === 3 ? (q.z - anchor.p.z) * anchor.v.z : 0)
    const c = cfg.safety - d
    jc += collisionPenalty(c, cfg.safety)
    const index = anchor.index - 1
    if (index < 0 || index >= m) continue
    // Eq. 7: the gradient is `v` scaled by −dj/dc. Every pair contributes a
    // direction, so a point that has discovered three obstacles is pulled by
    // three normals — the paper's "stronger deformation force".
    const scale = -collisionSlope(c, cfg.safety)
    gradC[index * 3] += anchor.v.x * scale
    gradC[index * 3 + 1] += anchor.v.y * scale
    if (dim === 3) gradC[index * 3 + 2] += anchor.v.z * scale
  }

  /* --- curve, for drawing and for the final collision check -------------- */
  const curve: Vec3[] = []
  let minClearance = Number.POSITIVE_INFINITY
  const density = Math.max(2, cfg.samplesPerSegment)
  for (let k = 0; k < segments; k += 1) {
    const p0 = control[k]
    const p1 = control[k + 1]
    const p2 = control[k + 2]
    const p3 = control[k + 3]
    for (let s = 0; s <= density; s += 1) {
      if (s === density && k < segments - 1) continue
      const t = s / density
      const b = basis(t)
      const point: Vec3 = {
        x: b[0] * p0.x + b[1] * p1.x + b[2] * p2.x + b[3] * p3.x,
        y: b[0] * p0.y + b[1] * p1.y + b[2] * p2.y + b[3] * p3.y,
        z: dim === 3 ? b[0] * p0.z + b[1] * p1.z + b[2] * p2.z + b[3] * p3.z : 0,
      }
      curve.push(point)
      const clearance = oracle.clearanceAt(point)
      if (clearance < minClearance) minClearance = clearance
    }
  }

  return {
    js,
    jc,
    curve,
    control,
    gradS,
    gradC,
    minClearance: Number.isFinite(minClearance) ? minClearance : 0,
  }
}

function totalGradient(e: Evaluation, cfg: EgoConfig): Float64Array {
  const out = new Float64Array(e.gradS.length)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = cfg.lambdaSmooth * e.gradS[i] + cfg.lambdaCollision * e.gradC[i]
  }
  return out
}

const totalCost = (e: Evaluation, cfg: EgoConfig) =>
  cfg.lambdaSmooth * e.js + cfg.lambdaCollision * e.jc

/**
 * Alg. 1 — discover obstacles, but only where the trajectory actually is.
 *
 * Samples the curve; for every colliding sample, attributes the hit to the
 * control point with the largest basis weight and gives that control point a
 * `{p, v}` pair. `p` is the nearest legal cell (the guide path's end, on the
 * obstacle surface within half a cell); `v` is the outward normal there, so it
 * points from the obstacle toward the trajectory regardless of which side of the
 * surface the control point sits on.
 */
function collectAnchors(
  oracle: EgoOracle,
  control: Vec3[],
  cfg: EgoConfig,
  store: EgoAnchor[],
  limitPerPoint = 4,
): number {
  const distinct = control.slice(2, control.length - 2)
  const segments = control.length - 3
  const density = Math.max(2, cfg.samplesPerSegment)
  const counts = new Map<number, number>()
  for (const anchor of store) counts.set(anchor.index, (counts.get(anchor.index) ?? 0) + 1)

  let added = 0
  for (let k = 0; k < segments; k += 1) {
    const p0 = control[k]
    const p1 = control[k + 1]
    const p2 = control[k + 2]
    const p3 = control[k + 3]
    for (let s = 0; s < density; s += 1) {
      const t = s / density
      const b = basis(t)
      const point: Vec3 = {
        x: b[0] * p0.x + b[1] * p1.x + b[2] * p2.x + b[3] * p3.x,
        y: b[0] * p0.y + b[1] * p1.y + b[2] * p2.y + b[3] * p3.y,
        z: oracle.dim === 3 ? b[0] * p0.z + b[1] * p1.z + b[2] * p2.z + b[3] * p3.z : 0,
      }
      // Touching the *obstacle* is the trigger; s_f is enforced by the penalty
      // afterwards, exactly as Alg. 1 does it.
      if (oracle.free(point, 0)) continue

      let best = 0
      let bestWeight = -1
      for (let c = 0; c < 4; c += 1) {
        if (b[c] > bestWeight) {
          bestWeight = b[c]
          best = k + c
        }
      }
      const index = best - 2
      if (index <= 0 || index >= distinct.length - 1) continue
      if ((counts.get(index) ?? 0) >= limitPerPoint) continue

      const p = oracle.nearestFree(point, 0)
      if (!p) continue
      const ox = p.x - point.x
      const oy = p.y - point.y
      const oz = oracle.dim === 3 ? p.z - point.z : 0
      const len = Math.hypot(ox, oy, oz)
      if (len < 1e-6) continue
      // Snap the normal to the dominant lattice axis.
      //
      // On a raster the surface a control point is pushed away from is a cell
      // face, whose normal is axis-aligned; the raw `p − point` direction comes
      // out diagonal because the nearest free *cell centre* is diagonal. Keeping
      // the diagonal would tilt every repulsion 45° and make the cost depend on
      // which corner of a cell happened to be free.
      const ax = Math.abs(ox)
      const ay = Math.abs(oy)
      const az = Math.abs(oz)
      const v =
        ax >= ay && ax >= az
          ? { x: Math.sign(ox), y: 0, z: 0 }
          : ay >= az
            ? { x: 0, y: Math.sign(oy), z: 0 }
            : { x: 0, y: 0, z: Math.sign(oz) }

      // The normal must point from the anchor toward the control point that owns
      // it. A ring search can return a free cell on the *far* side of a thin
      // wall; leaving that sign alone makes the "repulsion" pull the point
      // through the obstacle, which is the one failure this whole term exists to
      // avoid.
      const owner = distinct[index]
      const towardX = owner.x - p.x
      const towardY = owner.y - p.y
      const towardZ = oracle.dim === 3 ? owner.z - p.z : 0
      if (towardX * v.x + towardY * v.y + towardZ * v.z < 0) {
        v.x = -v.x
        v.y = -v.y
        v.z = -v.z
      }

      const duplicate = store.some(
        (anchor) =>
          anchor.index === index &&
          Math.hypot(anchor.p.x - p.x, anchor.p.y - p.y, anchor.p.z - p.z) < oracle.spacing * 0.5,
      )
      if (duplicate) continue
      store.push({ index, p, v })
      counts.set(index, (counts.get(index) ?? 0) + 1)
      added += 1
      break // one new pair per span per pass is enough to bend it
    }
  }
  return added
}

function countViolations(oracle: EgoOracle, curve: Vec3[]): number {
  let bad = 0
  for (const point of curve) if (!oracle.free(point, 0.5)) bad += 1
  return bad
}

/**
 * L-BFGS with a backtracking line search.
 *
 * Two-loop recursion, ten pairs, initial inverse Hessian scaled as in Eq. 13.
 * The objective is only piecewise smooth (a pair appears or disappears), so the
 * line search's job is to refuse any step that makes the total worse — that is
 * also what makes the convergence curve safe to draw.
 */
function lbfgs(
  inner: Vec3[],
  start: Vec3,
  goal: Vec3,
  cfg: EgoConfig,
  oracle: EgoOracle,
  anchors: EgoAnchor[],
  onIteration: (state: { js: number; jc: number; cost: number }) => void,
  budget: number,
) {
  const dim = oracle.dim
  const m = inner.length
  const size = m * 3
  let x: Float64Array<ArrayBufferLike> = new Float64Array(size)
  for (let i = 0; i < m; i += 1) {
    x[i * 3] = inner[i].x
    x[i * 3 + 1] = inner[i].y
    x[i * 3 + 2] = dim === 3 ? inner[i].z : 0
  }

  const toVec = (vector: Float64Array): Vec3[] =>
    Array.from({ length: m }, (_, i) => ({
      x: vector[i * 3],
      y: vector[i * 3 + 1],
      z: dim === 3 ? vector[i * 3 + 2] : 0,
    }))

  let evaluated = evaluate(toVec(x), start, goal, cfg, oracle, anchors)
  let cost = totalCost(evaluated, cfg)
  let grad = totalGradient(evaluated, cfg)

  const history: Array<{ s: Float64Array; y: Float64Array; rho: number }> = []
  const HISTORY = 10
  let iterations = 0
  let converged = false

  for (let iter = 0; iter < budget; iter += 1) {
    let norm = 0
    for (let i = 0; i < size; i += 1) norm += grad[i] * grad[i]
    norm = Math.sqrt(norm)
    if (norm < 1e-7) {
      converged = true
      onIteration({ js: evaluated.js, jc: evaluated.jc, cost })
      break
    }

    /* --- two-loop recursion, with Eq. 13 as H0 -------------------------- */
    let q = Float64Array.from(grad)
    const alpha: number[] = new Array(history.length).fill(0)
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const { s, y, rho } = history[i]
      let dot = 0
      for (let k = 0; k < size; k += 1) dot += s[k] * q[k]
      alpha[i] = rho * dot
      for (let k = 0; k < size; k += 1) q[k] -= alpha[i] * y[k]
    }
    let scale = 1
    if (history.length > 0) {
      const last = history[history.length - 1]
      let sy = 0
      let yy = 0
      for (let k = 0; k < size; k += 1) {
        sy += last.s[k] * last.y[k]
        yy += last.y[k] * last.y[k]
      }
      scale = yy > 1e-12 ? sy / yy : 1
    }
    for (let k = 0; k < size; k += 1) q[k] *= scale
    for (let i = 0; i < history.length; i += 1) {
      const { s, y, rho } = history[i]
      let dot = 0
      for (let k = 0; k < size; k += 1) dot += y[k] * q[k]
      const beta = rho * dot
      for (let k = 0; k < size; k += 1) q[k] += (alpha[i] - beta) * s[k]
    }

    let slope = 0
    for (let k = 0; k < size; k += 1) slope += grad[k] * q[k]
    if (slope >= 0) {
      q = new Float64Array(size)
      for (let k = 0; k < size; k += 1) q[k] = -grad[k]
      slope = -norm * norm
      history.length = 0
    }
    // Trust region on the control polygon.
    //
    // J_c is cubic, so one deep anchor can produce a gradient large enough to
    // throw a control point across the room in a single step — after which the
    // pair's `p` no longer refers to anything near it and the whole curve
    // diverges (this happened: points ended up at negative coordinates and the
    // room's corners became "anchors"). Capping the step at one cell per
    // iteration keeps every linearisation local, which is the assumption the
    // plane-distance field is built on.
    let qmax = 0
    for (let k = 0; k < size; k += 1) qmax = Math.max(qmax, Math.abs(q[k]))
    if (qmax > 1) {
      const shrink = 1 / qmax
      for (let k = 0; k < size; k += 1) q[k] *= shrink
      slope *= shrink
    }

    /* --- backtracking ---------------------------------------------------- */
    let step = 1
    let accepted: Float64Array | null = null
    let acceptedEval: Evaluation | null = null
    let acceptedCost = cost
    for (let line = 0; line < 18; line += 1) {
      const trial = new Float64Array(size)
      for (let k = 0; k < size; k += 1) {
        // The control polygon never leaves the map. A spline is only meaningful
        // inside the space it was built for; outside, the collision query has no
        // answer and the optimiser would happily use that emptiness as a way to
        // reduce J_c.
        const lo = 0.5
        const axis = k % 3
        const hi =
          axis === 0
            ? oracle.bounds.max.x - 0.5
            : axis === 1
              ? oracle.bounds.max.y - 0.5
              : oracle.bounds.max.z - 0.5
        const value = x[k] + step * q[k]
        trial[k] = Math.min(hi, Math.max(lo, value))
      }
      const trialEval = evaluate(toVec(trial), start, goal, cfg, oracle, anchors)
      const trialCost = totalCost(trialEval, cfg)
      const slack = 1e-10 * Math.max(1, Math.abs(cost))
      if (trialCost <= cost + 1e-4 * step * slope || trialCost < cost - slack) {
        accepted = trial
        acceptedEval = trialEval
        acceptedCost = trialCost
        break
      }
      step *= 0.5
    }
    if (!accepted || !acceptedEval) break

    const nextGrad = totalGradient(acceptedEval, cfg)
    const s = new Float64Array(size)
    const y = new Float64Array(size)
    for (let k = 0; k < size; k += 1) {
      s[k] = accepted[k] - x[k]
      y[k] = nextGrad[k] - grad[k]
    }
    let sy = 0
    for (let k = 0; k < size; k += 1) sy += s[k] * y[k]
    if (sy > 1e-12) {
      history.push({ s, y, rho: 1 / sy })
      if (history.length > HISTORY) history.shift()
    }

    const previous = cost
    x = accepted
    evaluated = acceptedEval
    grad = nextGrad
    cost = acceptedCost
    iterations = iter + 1
    onIteration({ js: evaluated.js, jc: evaluated.jc, cost })
    if (Math.abs(previous - cost) < 1e-9 * Math.max(1, cost)) {
      converged = true
      break
    }
  }

  return { inner: toVec(x), evaluated, iterations, cost, converged }
}

/** Eq. 2 — derivative control points from the position control points. */
function derivatives(control: Vec3[], dt: number, dim: 2 | 3) {
  const v: Vec3[] = []
  for (let i = 0; i + 1 < control.length; i += 1) {
    v.push({
      x: (control[i + 1].x - control[i].x) / dt,
      y: (control[i + 1].y - control[i].y) / dt,
      z: dim === 3 ? (control[i + 1].z - control[i].z) / dt : 0,
    })
  }
  const a: Vec3[] = []
  for (let i = 0; i + 1 < v.length; i += 1) {
    a.push({
      x: (v[i + 1].x - v[i].x) / dt,
      y: (v[i + 1].y - v[i].y) / dt,
      z: dim === 3 ? (v[i + 1].z - v[i].z) / dt : 0,
    })
  }
  const j: Vec3[] = []
  for (let i = 0; i + 1 < a.length; i += 1) {
    j.push({
      x: (a[i + 1].x - a[i].x) / dt,
      y: (a[i + 1].y - a[i].y) / dt,
      z: dim === 3 ? (a[i + 1].z - a[i].z) / dt : 0,
    })
  }
  return { v, a, j }
}

const norms = (list: Vec3[]) => list.map((p) => Math.hypot(p.x, p.y, p.z))

/**
 * Eq. 14/15 — how much the timetable has to stretch.
 *
 * The square root and the cube root are not decoration: V, A and J scale with
 * 1/Δt, 1/Δt² and 1/Δt³, so each derivative's excess enters the ratio in its own
 * power. Using the raw ratios (an earlier version of this file did) over-
 * stretches by a factor of √ for the acceleration term and ∛ for the jerk term.
 */
function exceedRatio(control: Vec3[], dt: number, cfg: EgoConfig, dim: 2 | 3) {
  const { v, a, j } = derivatives(control, dt, dim)
  let ratio = 1
  for (const speed of norms(v)) ratio = Math.max(ratio, speed / Math.max(1e-6, cfg.maxSpeed))
  for (const accel of norms(a)) ratio = Math.max(ratio, Math.sqrt(accel / Math.max(1e-6, cfg.maxAccel)))
  for (const jerk of norms(j)) ratio = Math.max(ratio, Math.cbrt(jerk / Math.max(1e-6, cfg.maxJerk)))
  return ratio
}

export interface EgoRun {
  solution: EgoSolution
  initialControl: Vec3[]
}

/**
 * Alg. 2 — rebound planning.
 *
 * `while not collision-free: discover anchors, evaluate, optimise`. The loop is
 * what produces the paper's "rebound between nearby obstacles": each pass
 * either adds a pair for a newly touched obstacle or finishes. Time
 * reallocation happens once, after the loop.
 */
export function runEgo(
  oracle: EgoOracle,
  start: Vec3,
  goal: Vec3,
  initPath: Vec3[],
  config: Partial<EgoConfig> = {},
): EgoRun {
  const cfg = { ...EGO_DEFAULTS, ...config }
  const polyline = initPath.length >= 2 ? initPath : [start, goal]
  const distinct = resample(polyline, cfg.controlPoints + 2)
  const inner = distinct.slice(1, distinct.length - 1)
  const initialControl = distinct.map((p) => ({ ...p }))
  const initialCurve = evaluate(inner, start, goal, cfg, oracle, []).curve

  const history: EgoSolution['history'] = []
  const push = (state: { js: number; jc: number; cost: number }) => {
    history.push({ js: state.js * cfg.lambdaSmooth, jc: state.jc, jd: 0, cost: state.cost })
  }

  const anchors: EgoAnchor[] = []
  let result = lbfgs(inner, start, goal, cfg, oracle, anchors, push, 0)
  let rebounds = 0
  let firstAnchors: EgoAnchor[] = []

  for (let pass = 0; pass < 8; pass += 1) {
    const added = collectAnchors(oracle, result.evaluated.control, cfg, anchors)
    if (pass === 0) firstAnchors = anchors.map((a) => ({ ...a, p: { ...a.p }, v: { ...a.v } }))
    if (added === 0) break
    rebounds = pass + 1
    result = lbfgs(result.inner, start, goal, cfg, oracle, anchors, push, cfg.maxIterations)
  }

  // Time reallocation, Eq. 14/15.
  const dim = oracle.dim
  const segments = inner.length + 3
  const dtBefore = Math.max(
    0.02,
    curveLength(result.evaluated.curve) / Math.max(0.1, cfg.maxSpeed) / Math.max(1, segments),
  )
  const ratio = exceedRatio(result.evaluated.control, dtBefore, cfg, dim)
  const dtAfter = dtBefore * ratio
  const before = derivatives(result.evaluated.control, dtBefore, dim)
  const after = derivatives(result.evaluated.control, dtAfter, dim)
  const speedBefore = norms(before.v)
  const speed = norms(after.v)
  const accel = norms(after.a)
  const jerk = norms(after.j)

  const violations = countViolations(oracle, result.evaluated.curve)
  const solution: EgoSolution = {
    control: result.evaluated.control
      .slice(2, result.evaluated.control.length - 2)
      .map((p) => ({ ...p })),
    curve: result.evaluated.curve,
    initialCurve,
    segments,
    dt: dtAfter,
    duration: dtAfter * segments,
    js: result.evaluated.js * cfg.lambdaSmooth,
    jc: result.evaluated.jc * cfg.lambdaCollision,
    jd: 0,
    cost: totalCost(result.evaluated, cfg),
    iterations: result.iterations,
    history,
    anchors,
    firstAnchors,
    speed,
    accel,
    jerk,
    speedBefore,
    maxSpeed: Math.max(0, ...speed),
    maxAccel: Math.max(0, ...accel),
    maxJerk: Math.max(0, ...jerk),
    maxSpeedBefore: Math.max(0, ...speedBefore),
    probes: oracle.probes(),
    violations,
    minClearance: result.evaluated.minClearance,
    converged: result.converged,
    dtBefore,
    dtAfter,
    ratio,
    rebounds,
    seed: initPath.length <= 2 ? 'naive' : 'front-end',
  }
  return { solution, initialControl }
}

/* ------------------------------------------------------------------ adapters - */

interface EgoTuning {
  safety: number
  lambdaSmooth: number
  maxSpeed: number
  lambdaCollision: number
  maxAccel: number
  maxJerk: number
}

function egoTuning(cards: CardsState, order: CardId[]): EgoTuning {
  // The three EGO cards are read through `tunedValue`: absent from the recipe
  // means "paper default", present means the slider's value. Same contract as
  // every other knob in the project.
  const safety = Math.max(0, tunedValue(cards, order, 'egoSafety', 2))
  const lambdaSmooth = Math.max(0.05, tunedValue(cards, order, 'egoSmooth', 1))
  const maxSpeed = Math.max(0.2, tunedValue(cards, order, 'egoSpeed', 2.4))
  // λ_c is not a card: it converts the paper's metres to this project's lattice
  // units. j_c has units of length³, so leaving λ_c near λ_s lets the smoothness
  // term win and the spline straightens itself through a wall — the failure the
  // paper's large λ_c exists to prevent.
  const lambdaCollision = Math.max(1, tunedValue(cards, order, 'clearance', 100))
  return {
    safety,
    lambdaSmooth,
    maxSpeed,
    lambdaCollision,
    maxAccel: Math.max(2, maxSpeed * 2.5),
    maxJerk: Math.max(5, maxSpeed * 8),
  }
}

/**
 * Cards for the *seed* search.
 *
 * Two things are switched off on purpose: the safety radius (the seed is allowed
 * to hug the walls) and the clearance cost term (which would otherwise push the
 * path away from obstacles on its own, so EGO would never see a collision). The
 * result is a shortest path that touches corners — exactly the "A* tends to lie
 * close to the obstacle surface" behaviour the paper relies on, and the reason
 * its optimiser has something to push.
 */
function seedCards(cards: CardsState, radius: number): CardsState {
  return {
    ...cards,
    collision: { enabled: radius > 0, value: radius },
    clearance: { enabled: false, value: 0 },
  }
}

/**
 * A collision-free seed, used only when the paper's naive start cannot rebound
 * out of a tight scene. The radius steps down until a route exists: a margin
 * wider than every corridor has no solution at all, and a straight line through
 * the walls is worse than a slightly less generous path.
 */
function frontPath(
  latticeFor: (radius: number) => Lattice,
  start: Vec3,
  goal: Vec3,
  preferred: number,
  fallback: number,
): Vec3[] {
  for (const radius of [preferred, fallback, 0.6, 0]) {
    const outcome = searchLattice(latticeFor(radius), {
      mode: 'astar',
      start,
      goal,
      goalTolerance: 0,
    })
    if (outcome.found && outcome.path.length >= 2) return outcome.path
  }
  return [start, goal]
}

/** Shared tail: build the PlanResult both dimensions report. */
function assemble(options: {
  solution: EgoSolution
  initialPath: Vec3[]
  grid: boolean
  label: string
  solver: string
  space: SpaceKind
  notes: string[]
  tuning: EgoTuning
}): PlanResult {
  const { solution, grid, tuning } = options
  const events: SearchEvent[] = solution.history.map((state, index) => {
    const at = solution.curve[
      Math.min(
        solution.curve.length - 1,
        Math.round((index / Math.max(1, solution.history.length - 1)) * (solution.curve.length - 1)),
      )
    ]
    return {
      x: at?.x ?? 0,
      y: at?.y ?? 0,
      z: at?.z,
      // g/h/f carry the three cost terms: the flow panel prints them in the same
      // slots an A* run uses, so the replay reads the same way.
      g: state.js,
      h: state.jc,
      f: state.cost,
      openSize: solution.anchors.length,
    }
  })
  if (events.length === 0) {
    events.push({
      x: solution.curve[0]?.x ?? 0,
      y: solution.curve[0]?.y ?? 0,
      g: 0,
      h: 0,
      f: 0,
      openSize: 0,
    })
  }

  const length = curveLength(solution.curve)
  const path: Point[] = grid ? solution.curve.map((p) => ({ x: p.x, y: p.y })) : []
  const trace = {
    kind: 'gradient' as const,
    loopLabel: 'L-BFGS · 直到碰撞消失',
    init: [
      `Q ← ${solution.control.length} 个控制点（三次 B 样条，两端三重固定）`,
      `Δt ← ${solution.dtBefore.toFixed(3)} s · v_max ${tuning.maxSpeed.toFixed(1)} · s_f ${tuning.safety.toFixed(1)}`,
      `λ_s ${tuning.lambdaSmooth.toFixed(1)} · λ_c ${tuning.lambdaCollision.toFixed(0)}`,
    ],
    loop: [
      '采样曲线：找到撞进障碍的那一段',
      'p ← 障碍面锚点，v ← 该处外法向',
      'c = s_f − (Q − p)·v',
      'J_c += c³ / 3s_f c² − 3s_f² c + s_f³',
      '∇J = λ_s∇J_s + λ_c∇J_c    (∇J_c = −v·dj/dc)',
      'L-BFGS 步长 + 回溯线搜索',
    ],
    terminate: [
      `Δt ← Δt · max(|v|/v_max, √(|a|/a_max), ∛(|j|/j_max)) = ${solution.dtAfter.toFixed(3)} s`,
      'return Q, Δt',
    ],
  }

  return {
    status: solution.violations === 0 ? 'success' : 'infeasible',
    continuous: true,
    path,
    rawPath: options.initialPath.map((p) => ({ x: p.x, y: p.y })),
    path3: solution.curve.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    events,
    expanded: solution.iterations,
    expandedCells: solution.anchors.length,
    pathLength: length,
    minClearance: solution.minClearance,
    totalCost: solution.cost,
    cost: { length, clearance: solution.jc, turn: 0, bias: 0 },
    solveTime: 0,
    waypoints: solution.curve.length,
    smoothed: true,
    algorithmLabel: options.label,
    openAtEnd: solution.anchors.length,
    solver: options.solver,
    space: options.space,
    trace,
    note: options.notes.join(' · '),
    rounds: solution.iterations,
    duration: solution.duration,
  }
}

function runWithFallback(
  oracle: EgoOracle,
  start: Vec3,
  goal: Vec3,
  cfg: Partial<EgoConfig>,
  seedFor: (radius: number) => Vec3[],
  margin: number,
): { run: EgoRun; initialPath: Vec3[]; radius: number } {
  // Three seeds, in order of how much work they leave the optimiser.
  //
  //  1. A shortest path that **hugs the walls** (radius 0, clearance cost off).
  //     This is the paper's premise — "A* tends to lie close to the obstacle
  //     surface" — and the only seed that reliably puts the spline inside an
  //     obstacle, so the collision term has something to push against.
  //  2. The same path at the safety margin, for scenes where a corner-hugging
  //     spline cannot be pushed out within the budget.
  //  3. The naive spline the paper starts from, if the front end finds nothing.
  //
  // The first seed that comes back feasible wins, so the answer degrades
  // gracefully instead of failing.
  const attempts: Array<{ seed: Vec3[]; radius: number }> = [
    { seed: seedFor(0), radius: 0 },
    { seed: seedFor(margin), radius: margin },
    { seed: [start, goal], radius: -1 },
  ]
  let fallback: { run: EgoRun; initialPath: Vec3[]; radius: number } | null = null
  for (const attempt of attempts) {
    if (attempt.seed.length < 2) continue
    const run = runEgo(oracle, start, goal, attempt.seed, cfg)
    const candidate = { run, initialPath: attempt.seed, radius: attempt.radius }
    if (run.solution.violations === 0) return candidate
    if (!fallback || run.solution.violations < fallback.run.solution.violations) fallback = candidate
  }
  return fallback ?? { run: runEgo(oracle, start, goal, [start, goal], cfg), initialPath: [start, goal], radius: -1 }
}

/** 2D: solve on the raster, return a float path the canvas draws directly. */
export function planEgoGrid(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  const startedAt = performance.now()
  const tuning = egoTuning(cards, order)
  const lattice = gridLattice(map, cards, lengthScale(cards))
  const start = { x: map.start.x + 0.5, y: map.start.y + 0.5, z: 0 }
  const goal = { x: map.goal.x + 0.5, y: map.goal.y + 0.5, z: 0 }
  const oracle = oracleFromLattice(lattice, tuning.safety)
  const cfg = {
    safety: tuning.safety,
    lambdaSmooth: tuning.lambdaSmooth,
    lambdaCollision: tuning.lambdaCollision,
    maxSpeed: tuning.maxSpeed,
    maxAccel: tuning.maxAccel,
    maxJerk: tuning.maxJerk,
    controlPoints: 9,
  }

  const { run, initialPath, radius } = runWithFallback(
    oracle,
    start,
    goal,
    cfg,
    (r) =>
      frontPath(
        (radius2) => gridLattice(map, seedCards(cards, radius2), lengthScale(cards)),
        start,
        goal,
        r,
        r,
      ),
    tuning.safety,
  )

  const result = assemble({
    solution: run.solution,
    initialPath,
    grid: true,
    label: spec.label,
    solver: spec.id,
    space: 'grid2d',
    tuning,
    notes: [
      `${run.solution.control.length} 控制点 · ${run.solution.iterations} 次迭代 · ${run.solution.rebounds} 轮回弹`,
      `${run.solution.anchors.length} 组 {p, v} 锚点 · 初值${
        radius < 0 ? '是不管障碍的一条样条' : radius === 0 ? '是贴墙的最短路' : `保持 ${radius.toFixed(1)} 格`
      }`,
      `Δt ${run.solution.dtBefore.toFixed(2)}→${run.solution.dtAfter.toFixed(
        2,
      )} s（式 14 比值 ${run.solution.ratio.toFixed(2)}）`,
      '未做论文 Sec. V 的各向异性曲线拟合：只拉伸 Δt，形状不变',
    ],
  })
  result.solveTime = performance.now() - startedAt
  return result
}

/** 3D / continuous fields: same optimiser, lattice only as a collision oracle. */
export function planEgoWorld(input: LatticePlanInput): PlanResult {
  const { world, spec, cards, order, endpoints } = input
  const startedAt = performance.now()
  const tuning = egoTuning(cards, order)
  const lattice = buildLattice(world, cards, endpoints.goal)
  const spacing = lattice.spacing
  const oracle = oracleFromLattice(lattice, tuning.safety * spacing)
  const cfg = {
    safety: tuning.safety,
    lambdaSmooth: tuning.lambdaSmooth,
    lambdaCollision: tuning.lambdaCollision,
    maxSpeed: tuning.maxSpeed,
    maxAccel: tuning.maxAccel,
    maxJerk: tuning.maxJerk,
    controlPoints: 9,
  }

  const { run, initialPath, radius } = runWithFallback(
    oracle,
    endpoints.start,
    endpoints.goal,
    cfg,
    (r) =>
      frontPath(
        (radius2) => buildLattice(world, seedCards(cards, radius2), endpoints.goal),
        endpoints.start,
        endpoints.goal,
        r,
        r,
      ),
    tuning.safety,
  )

  const result = assemble({
    solution: run.solution,
    initialPath,
    grid: false,
    label: spec.label,
    solver: spec.id,
    space: world.kind,
    tuning,
    notes: [
      `${lattice.width}×${lattice.height}${
        lattice.dim === 3 ? `×${lattice.depth}` : ''
      } 只作碰撞查询，未建距离场`,
      `${run.solution.control.length} 控制点 · ${run.solution.iterations} 次迭代 · ${
        run.solution.rebounds
      } 轮回弹 · ${run.solution.anchors.length} 组 {p, v} · 初值${
        radius < 0 ? '是一条直线' : radius === 0 ? '贴墙' : `保持 ${radius.toFixed(1)} 格`
      }`,
      `Δt ${run.solution.dtBefore.toFixed(2)}→${run.solution.dtAfter.toFixed(
        2,
      )} s（式 14 比值 ${run.solution.ratio.toFixed(2)}）`,
      '未做论文 Sec. V 的各向异性曲线拟合：只拉伸 Δt，形状不变',
    ],
  })
  result.solveTime = performance.now() - startedAt
  // 3D reports clearance in metres, like `lattice3d`.
  result.minClearance = run.solution.minClearance * spacing
  return result
}

export function egoMetrics(solution: EgoSolution) {
  return {
    js: solution.js,
    jc: solution.jc,
    jd: solution.jd,
    cost: solution.cost,
    iterations: solution.iterations,
    controlPoints: solution.control.length,
    anchors: solution.anchors.length,
    dtBefore: solution.dtBefore,
    dtAfter: solution.dtAfter,
    ratio: solution.ratio,
    duration: solution.duration,
    maxSpeed: solution.maxSpeed,
    maxAccel: solution.maxAccel,
    maxJerk: solution.maxJerk,
    minClearance: solution.minClearance,
    violations: solution.violations,
    probes: solution.probes,
    rebounds: solution.rebounds,
  }
}
