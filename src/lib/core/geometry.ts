/**
 * Path geometry shared by every solver's post-processing stage.
 *
 * Each helper takes a `clear` predicate instead of a map so the same code can
 * run on a 2D grid, a voxel grid or a continuous field adapter.
 */
import type { Point } from '../types'

export type ClearFn = (a: Point, b: Point) => boolean

export function polylineLength(points: Point[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  return total
}

export function pathClear(points: Point[], clear: ClearFn): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (!clear(points[i - 1], points[i])) return false
  }
  return true
}

/** Chaikin corner cutting. Each pass doubles the point count minus the ends. */
export function chaikin(points: Point[], iterations: number): Point[] {
  let current = points
  for (let pass = 0; pass < iterations; pass += 1) {
    if (current.length < 3) break
    const next: Point[] = [current[0]]
    for (let i = 0; i < current.length - 1; i += 1) {
      const a = current[i]
      const b = current[i + 1]
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
    }
    next.push(current[current.length - 1])
    current = next
  }
  return current
}

/**
 * Greedy line-of-sight pruning: from each anchor, jump to the farthest point
 * that is still directly visible.
 */
export function lineOfSight(points: Point[], clear: ClearFn): Point[] {
  if (points.length <= 2) return points
  const result: Point[] = [points[0]]
  let anchor = 0
  while (anchor < points.length - 1) {
    let next = points.length - 1
    while (next > anchor + 1 && !clear(points[anchor], points[next])) {
      next -= 1
    }
    result.push(points[next])
    anchor = next
  }
  return result
}

/** Collapse points whose perpendicular distance to the chord is under τ. */
export function simplifyPolyline(
  points: Point[],
  tolerance: number,
  clear: ClearFn,
): Point[] {
  if (points.length <= 2) return [...points]
  const result = [...points]
  let changed = true
  while (changed) {
    changed = false
    for (let i = 1; i < result.length - 1; i += 1) {
      const a = result[i - 1]
      const p = result[i]
      const b = result[i + 1]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy)
      const perpendicular =
        length < 1e-9
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / length
      if (perpendicular <= tolerance + 1e-9 && clear(a, b)) {
        result.splice(i, 1)
        changed = true
        i -= 1
      }
    }
  }
  return result
}

/**
 * Replace each corner with a quadratic arc, shrinking the radius until the arc
 * clears. Falls back to the sharp corner when no radius fits.
 */
export function roundCorners(points: Point[], radius: number, clear: ClearFn): Point[] {
  if (points.length <= 2) return points
  const result: Point[] = [points[0]]
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    const c = points[i + 1]
    const l1 = Math.hypot(b.x - a.x, b.y - a.y)
    const l2 = Math.hypot(c.x - b.x, c.y - b.y)
    if (l1 < 1e-6 || l2 < 1e-6) {
      result.push(b)
      continue
    }
    let rounded: Point[] | null = null
    for (const scale of [1, 0.68, 0.42, 0.22]) {
      const r = Math.min(radius * scale, l1 * 0.45, l2 * 0.45)
      if (r < 0.03) continue
      const p1 = { x: b.x + ((a.x - b.x) * r) / l1, y: b.y + ((a.y - b.y) * r) / l1 }
      const p2 = { x: b.x + ((c.x - b.x) * r) / l2, y: b.y + ((c.y - b.y) * r) / l2 }
      const samples = Math.max(5, Math.ceil(r * 14))
      const curve: Point[] = []
      for (let step = 0; step <= samples; step += 1) {
        const t = step / samples
        const u = 1 - t
        curve.push({
          x: u * u * p1.x + 2 * u * t * b.x + t * t * p2.x,
          y: u * u * p1.y + 2 * u * t * b.y + t * t * p2.y,
        })
      }
      if (pathClear(curve, clear)) {
        rounded = curve
        break
      }
    }
    if (rounded) result.push(...rounded)
    else result.push(b)
  }
  result.push(points[points.length - 1])
  return pathClear(result, clear) ? result : points
}

/** Resample a polyline to `count` evenly spaced points. */
export function resample(points: Point[], count: number): Point[] {
  if (points.length === 0) return []
  if (points.length === 1 || count < 2) return [{ ...points[0] }]
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    )
    lengths.push(length)
    total += length
  }
  if (total < 1e-9) return Array.from({ length: count }, () => ({ ...points[0] }))
  const step = total / (count - 1)
  const out: Point[] = [{ ...points[0] }]
  let segment = 0
  let travelled = 0
  for (let i = 1; i < count - 1; i += 1) {
    const target = step * i
    while (segment < lengths.length - 1 && travelled + lengths[segment] < target) {
      travelled += lengths[segment]
      segment += 1
    }
    const t = lengths[segment] < 1e-9 ? 0 : (target - travelled) / lengths[segment]
    out.push({
      x: points[segment].x + (points[segment + 1].x - points[segment].x) * t,
      y: points[segment].y + (points[segment + 1].y - points[segment].y) * t,
    })
  }
  out.push({ ...points[points.length - 1] })
  return out
}

/** Deterministic PRNG (mulberry32) so every replay of a run is identical. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
