/**
 * Wire format between the UI and whatever solves the job.
 *
 * The same message is valid for three transports:
 *  - `inline`  — called directly on the main thread (fast solvers);
 *  - `worker`  — a dedicated worker (heavy solvers, keeps the canvas at 60fps);
 *  - `http`    — a future server endpoint, enabled by setting
 *                `VITE_SOLVER_ENDPOINT`. The app is a static single file today,
 *                so this path is dormant; the point is that the payload, the
 *                result shape and the progress channel already match, and a
 *                server can be added without touching any solver.
 */
import type { CardId, CardsState, GridMap, PlanResult, Point } from '../types'
import type { Bounds, Primitive, Vec3, VoxelVolume } from '../core/space'

/**
 * Bumped to 2 when the request grew a dimension-agnostic `space` field.
 *
 * v1 sent `{ map }` and could only describe a 2D cell grid. v2 sends
 * `{ space }`, where `{ kind: 'grid2d', map }` is the *same* payload as before
 * — so a v2 server can still answer v1-shaped questions, but not the other way
 * round. The worker rejects mismatches instead of guessing.
 */
export const PROTOCOL_VERSION = 2

export interface MapPayload {
  id: string
  name: string
  description: string
  width: number
  height: number
  cells: ArrayBuffer
  clearance: ArrayBuffer
  start: Point
  goal: Point
  cellSize: number
}

/** A voxel volume on the wire. `clearance` is in voxels, like the local field. */
export interface VolumePayload {
  width: number
  height: number
  depth: number
  spacing: number
  origin: Vec3
  cells: ArrayBuffer
  clearance: ArrayBuffer
}

/**
 * An analytic field on the wire: primitives plus a *resolution*, not a raster.
 * The resolution is a request parameter precisely because the same continuous
 * space can be solved coarsely or finely — that choice belongs to the caller,
 * not to an exported asset.
 */
export interface FieldPayload {
  dim: 2 | 3
  bounds: Bounds
  primitives: Primitive[]
  resolution: number
}

/**
 * What a job is solved in.
 *
 * The union is closed on purpose: a server that answers `grid2d` and `voxel3d`
 * today can add `field3d` tomorrow without a version bump, because the tag is
 * what it switches on. Unknown tags are a clear error, not a silent 2D fallback.
 */
export type SpacePayload =
  | { kind: 'grid2d'; map: MapPayload }
  | { kind: 'voxel3d'; volume: VolumePayload }
  | { kind: 'field2d' | 'field3d'; field: FieldPayload }

export interface SolveRequest {
  version: number
  id: number
  space: SpacePayload
  cards: CardsState
  order: CardId[]
  /** Wall-clock budget for the solver; the worker stops and returns partial work. */
  budgetMs?: number
}

export type WorkerInbound =
  | { kind: 'solve'; request: SolveRequest }
  | { kind: 'cancel'; id: number }

export type WorkerOutbound =
  | { kind: 'progress'; id: number; fraction: number }
  | { kind: 'result'; id: number; result: PlanResult; elapsed: number }
  | { kind: 'error'; id: number; message: string }

export function encodeMap(map: GridMap): MapPayload {
  return {
    id: map.id,
    name: map.name,
    description: map.description,
    width: map.width,
    height: map.height,
    cells: map.cells.slice().buffer,
    clearance: map.clearance.slice().buffer,
    start: { ...map.start },
    goal: { ...map.goal },
    cellSize: map.cellSize,
  }
}

export function decodeMap(payload: MapPayload): GridMap {
  return {
    id: payload.id as GridMap['id'],
    name: payload.name,
    description: payload.description,
    width: payload.width,
    height: payload.height,
    cells: new Uint8Array(payload.cells),
    clearance: new Float32Array(payload.clearance),
    start: { ...payload.start },
    goal: { ...payload.goal },
    cellSize: payload.cellSize,
  }
}

export function gridSpace(map: GridMap): SpacePayload {
  return { kind: 'grid2d', map: encodeMap(map) }
}

export function voxelSpace(volume: VoxelVolume): SpacePayload {
  return {
    kind: 'voxel3d',
    volume: {
      width: volume.width,
      height: volume.height,
      depth: volume.depth,
      spacing: volume.spacing,
      origin: { ...volume.origin },
      cells: volume.cells.slice().buffer,
      clearance: volume.clearance.slice().buffer,
    },
  }
}

export function fieldSpace(
  dim: 2 | 3,
  bounds: Bounds,
  primitives: Primitive[],
  resolution: number,
): SpacePayload {
  return { kind: dim === 3 ? 'field3d' : 'field2d', field: { dim, bounds, primitives, resolution } }
}

export type DecodedSpace =
  | { kind: 'grid2d'; map: GridMap }
  | { kind: 'voxel3d'; volume: VoxelVolume }
  | { kind: 'field2d' | 'field3d'; field: FieldPayload }

export function decodeSpace(payload: SpacePayload): DecodedSpace {
  if (payload.kind === 'grid2d') return { kind: 'grid2d', map: decodeMap(payload.map) }
  if (payload.kind === 'voxel3d') {
    const volume = payload.volume
    return {
      kind: 'voxel3d',
      volume: {
        width: volume.width,
        height: volume.height,
        depth: volume.depth,
        spacing: volume.spacing,
        origin: { ...volume.origin },
        cells: new Uint8Array(volume.cells),
        clearance: new Float32Array(volume.clearance),
      },
    }
  }
  return { kind: payload.kind, field: payload.field }
}

// ---------------------------------------------------------------------------
// JSON codec
//
// Workers use structured clone and need none of this. The HTTP transport has to
// survive JSON, so typed arrays are base64-encoded on the way out and rebuilt on
// the way in. Keeping both directions here means a server only has to mirror
// this one file's shape.
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, offset + chunk)))
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export type JsonMap = Omit<MapPayload, 'cells' | 'clearance'> & {
  cells: string
  clearance: string
}

export function mapToJson(payload: MapPayload): JsonMap {
  return {
    ...payload,
    cells: toBase64(new Uint8Array(payload.cells)),
    clearance: toBase64(new Uint8Array(payload.clearance)),
  }
}

export function mapFromJson(json: JsonMap): MapPayload {
  return {
    ...json,
    cells: fromBase64(json.cells).buffer as ArrayBuffer,
    clearance: fromBase64(json.clearance).buffer as ArrayBuffer,
  }
}

export type JsonVolume = Omit<VolumePayload, 'cells' | 'clearance'> & {
  cells: string
  clearance: string
}

export type JsonSpacePayload =
  | { kind: 'grid2d'; map: JsonMap }
  | { kind: 'voxel3d'; volume: JsonVolume }
  | { kind: 'field2d' | 'field3d'; field: FieldPayload }

/**
 * The HTTP body. Structured clone handles typed arrays for the worker, but JSON
 * does not, so every binary field is base64 here. `field` spaces carry no
 * binary at all — that is one of the reasons to prefer them for a remote solve:
 * a 40 KB primitive list beats a 2 MB voxel block on the wire.
 */
export function spaceToJson(payload: SpacePayload): JsonSpacePayload {
  if (payload.kind === 'grid2d') {
    return { kind: 'grid2d', map: mapToJson(payload.map) }
  }
  if (payload.kind === 'voxel3d') {
    const { volume } = payload
    return {
      kind: 'voxel3d',
      volume: {
        ...volume,
        cells: toBase64(new Uint8Array(volume.cells)),
        clearance: toBase64(new Uint8Array(volume.clearance)),
      },
    }
  }
  return { kind: payload.kind, field: payload.field }
}

export function spaceFromJson(json: JsonSpacePayload): SpacePayload {
  if (json.kind === 'grid2d') return { kind: 'grid2d', map: mapFromJson(json.map) }
  if (json.kind === 'voxel3d') {
    const { volume } = json
    return {
      kind: 'voxel3d',
      volume: {
        ...volume,
        cells: fromBase64(volume.cells).buffer as ArrayBuffer,
        clearance: fromBase64(volume.clearance).buffer as ArrayBuffer,
      },
    }
  }
  return { kind: json.kind, field: json.field }
}

export type JsonResult = Omit<PlanResult, 'field'> & {
  field?: Omit<NonNullable<PlanResult['field']>, 'values'> & { values: string }
}

export function resultToJson(result: PlanResult): JsonResult {
  if (!result.field) return result as JsonResult
  const { values, ...rest } = result.field
  return {
    ...result,
    field: { ...rest, values: toBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)) },
  }
}

export function resultFromJson(json: JsonResult): PlanResult {
  if (!json.field) return json as PlanResult
  const bytes = fromBase64(json.field.values)
  const values = new Float32Array(bytes.length / 4)
  new Uint8Array(values.buffer).set(bytes)
  return {
    ...json,
    field: { ...json.field, values },
  } as PlanResult
}
