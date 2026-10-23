/**
 * Direction tables for 2D and 3D lattices.
 *
 * The 2D order is deliberately the same as `DX` / `DY` in `core/costs.ts`
 * (E, SE, S, SW, W, NW, N, NE) so a direction index means the same thing in
 * both worlds — `dir & 1` is still "diagonal". 3D appends the other 18 moves,
 * ordered by how many axes they change so that a 6-connected restriction is
 * simply "the first six entries".
 */
import { D2_TURN, D3_TURN } from './types'

const D2X = [1, 1, 0, -1, -1, -1, 0, 1]
const D2Y = [0, 1, 1, 1, 0, -1, -1, -1]

export const DIRS_2D = D2X.map((x, i) => ({ x, y: D2Y[i], z: 0 }))

export const DIRS_3D: Array<{ x: number; y: number; z: number }> = (() => {
  const out: Array<{ x: number; y: number; z: number }> = []
  for (let z = -1; z <= 1; z += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let x = -1; x <= 1; x += 1) {
        if (x === 0 && y === 0 && z === 0) continue
        out.push({ x, y, z })
      }
    }
  }
  // Sort face moves (1 axis) first, then edge (2), then corner (3). Within a
  // tier keep the loop order, which is stable and therefore shareable.
  const tier = (d: { x: number; y: number; z: number }) =>
    Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z)
  return out.sort((a, b) => tier(a) - tier(b))
})()

/** 1, √2 or √3 depending on how many axes the move changes. */
export function stepLength(dir: { x: number; y: number; z: number }): number {
  const axes = Math.abs(dir.x) + Math.abs(dir.y) + Math.abs(dir.z)
  return axes === 1 ? 1 : axes === 2 ? Math.SQRT2 : Math.sqrt(3)
}

function quantize(value: number): number {
  return Math.round(value * 1e12) / 1e12
}

/**
 * Turn cost between two directions, in units of 90°.
 *
 * For 2D this reproduces `gridStepCost`'s `delta / 2` exactly: direction
 * indices are 45° apart, so `min(|a-b|, 8-|a-b|) / 2` is the angle in right
 * angles. Deriving it from the angle instead of the index keeps the same
 * meaning in 3D, where indices are not evenly spaced in rotation.
 *
 * The angle comes from `atan2(|a × b|, a · b)`, not `acos(a · b)`. `acos` loses
 * about 1e-8 near ±1 — enough that a U-turn would cost 1.99999999 instead of 2
 * and the 2D equivalence test would miss by 6e-9 on every step. `atan2` is
 * exact at 0° and 180°.
 */
function turnUnits(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const cross = Math.hypot(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  )
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  return quantize(Math.atan2(cross, dot) / (Math.PI / 2))
}

function buildTurnTable(dirs: Array<{ x: number; y: number; z: number }>): number[][] {
  const units = dirs.map((d) => {
    const length = Math.hypot(d.x, d.y, d.z)
    return { x: d.x / length, y: d.y / length, z: d.z / length }
  })
  return units.map((a) => units.map((b) => turnUnits(a, b)))
}

D2_TURN.push(...buildTurnTable(DIRS_2D))
D3_TURN.push(...buildTurnTable(DIRS_3D))

export function dirsFor(dim: 2 | 3): Array<{ x: number; y: number; z: number }> {
  return dim === 2 ? DIRS_2D : DIRS_3D
}

export function turnTableFor(dim: 2 | 3): number[][] {
  return dim === 2 ? D2_TURN : D3_TURN
}

/**
 * Octile distance in 2D, octile-ish in 3D (Chebyshev with the two extra
 * diagonal tiers priced in). Admissible for the 26-neighbourhood; the 2D branch
 * is byte-identical to `heuristicOf`'s distance term.
 */
export function octile(dx: number, dy: number, dz: number, diagonal: boolean): number {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const az = Math.abs(dz)
  if (az < 1e-9) {
    if (!diagonal) return ax + ay
    return Math.max(ax, ay) + (Math.SQRT2 - 1) * Math.min(ax, ay)
  }
  const max = Math.max(ax, ay, az)
  const min = Math.min(ax, ay, az)
  const mid = ax + ay + az - max - min
  return max + (Math.SQRT2 - 1) * mid + (Math.sqrt(3) - Math.SQRT2) * min
}
