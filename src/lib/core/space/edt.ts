/**
 * Exact Euclidean distance transform.
 *
 * Both clearance fields need "distance to the nearest obstacle" for every free
 * cell. The naive version is O(cells × obstacle cells), which is fine for the
 * 44×28 maps (the UI's clearance field predates this module) but hopeless for a
 * voxel block — 44×28×12 with a few thousand blocked voxels is already 10⁸
 * distance evaluations per rebuild.
 *
 * This is the separable algorithm from Felzenszwalb & Huttenlocher: a 1D squared
 * distance transform is exact and linear, and the 3D transform is three passes
 * of it (x, then y, then z). Complexity O(N) regardless of how many obstacles
 * there are, which is what makes "rebuild the clearance field on every edit"
 * viable.
 *
 * It also gives *exactly* the same numbers as the 2D map builder's brute force
 * loop, because both measure centre-to-centre Euclidean distance. The
 * equivalence is asserted in `scripts/space.ts`.
 */

const FAR = 1e20

/**
 * In-place 1D squared distance transform of `f`, written to `d`.
 * `f[q]` is the seed cost at q (0 on an obstacle); `d[q]` becomes
 * `min over p of (f[p] + (q-p)²)`.
 */
export function dt1d(
  f: Float64Array,
  d: Float64Array,
  n: number,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0
  v[0] = 0
  z[0] = -Number.POSITIVE_INFINITY
  z[1] = Number.POSITIVE_INFINITY
  for (let q = 1; q < n; q += 1) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k -= 1
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k += 1
    v[k] = q
    z[k] = s
    z[k + 1] = Number.POSITIVE_INFINITY
  }
  k = 0
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1
    const delta = q - v[k]
    d[q] = delta * delta + f[v[k]]
  }
}

export interface Volume {
  width: number
  height: number
  depth: number
}

/**
 * Squared distance (in cells) from every cell to the nearest blocked cell,
 * 0 on blocked cells themselves.
 */
export function squaredEDT(
  blocked: Uint8Array,
  { width, height, depth }: Volume,
): Float64Array {
  const size = width * height * depth
  const field = new Float64Array(size)
  for (let i = 0; i < size; i += 1) field[i] = blocked[i] === 1 ? 0 : FAR

  const maxAxis = Math.max(width, height, depth)
  const f = new Float64Array(maxAxis)
  const d = new Float64Array(maxAxis)
  const v = new Int32Array(maxAxis + 1)
  const z = new Float64Array(maxAxis + 2)

  // Gather a strided line, transform it, scatter it back. Three call sites
  // below because writing one generic strided walker is how you get an
  // off-by-one that only shows up on non-square volumes.
  const line = (start: number, stride: number, count: number) => {
    for (let i = 0; i < count; i += 1) f[i] = field[start + i * stride]
    dt1d(f, d, count, v, z)
    for (let i = 0; i < count; i += 1) field[start + i * stride] = d[i]
  }

  for (let z0 = 0; z0 < depth; z0 += 1) {
    for (let y0 = 0; y0 < height; y0 += 1) {
      line(z0 * width * height + y0 * width, 1, width)
    }
  }
  for (let z0 = 0; z0 < depth; z0 += 1) {
    for (let x0 = 0; x0 < width; x0 += 1) {
      line(z0 * width * height + x0, width, height)
    }
  }
  if (depth > 1) {
    for (let y0 = 0; y0 < height; y0 += 1) {
      for (let x0 = 0; x0 < width; x0 += 1) {
        line(y0 * width + x0, width * height, depth)
      }
    }
  }
  return field
}

/** Distance in cells (not squared), clamped to `cap`. */
export function edtClearance(
  blocked: Uint8Array,
  volume: Volume,
  cap = 999,
): Float32Array {
  const squared = squaredEDT(blocked, volume)
  const out = new Float32Array(squared.length)
  const limit = cap * cap
  for (let i = 0; i < squared.length; i += 1) {
    const value = squared[i]
    out[i] = value >= limit ? cap : Math.sqrt(value)
  }
  return out
}
