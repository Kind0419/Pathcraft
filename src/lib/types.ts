export type MapId = 'notch' | 'gate' | 'clutter'

export type CardId =
  | 'strategy'
  | 'heuristic'
  | 'diagonal'
  | 'clearance'
  | 'turn'
  | 'collision'
  | 'noUTurn'
  | 'maxTurn'
  | 'smooth'
  | 'round'
  | 'goalTolerance'
  | 'cornerCut'
  | 'lengthWeight'
  | 'diagonalBias'
  | 'budget'
  | 'simplify'
  | 'swarmWidth'
  | 'iterations'
  | 'incremental'

export type CardGroup = 'search' | 'cost' | 'constraint' | 'bridge'

export interface CardState {
  enabled: boolean
  value: number
}

export type CardsState = Record<CardId, CardState>

export interface Point {
  x: number
  y: number
}

export interface GridMap {
  id: MapId
  name: string
  description: string
  width: number
  height: number
  cells: Uint8Array
  clearance: Float32Array
  start: Point
  goal: Point
  cellSize: number
}

export interface SearchEvent {
  x: number
  y: number
  /** Present for voxel / field-3D runs; the 2D canvas ignores it. */
  z?: number
  g: number
  h: number
  f: number
  openSize: number
}

export interface CostBreakdown {
  length: number
  clearance: number
  turn: number
  bias: number
}

export type PlanStatus = 'success' | 'infeasible'

/** Which surface a run solved on. 3D adapters exist but are not wired to the UI. */
export type SpaceKind = 'grid2d' | 'sampling2d' | 'voxel3d' | 'field2d' | 'field3d'

/** How a solver iterates. The flow panel renders from this instead of guessing. */
export type TraceKind =
  | 'graph'
  | 'jps'
  | 'iterative'
  | 'bidirectional'
  | 'beam'
  | 'incremental'
  | 'sampling'
  | 'meta'

export interface TraceSpec {
  kind: TraceKind
  /** Loop keyword shown next to the stage title, e.g. `WHILE OPEN ≠ ∅`. */
  loopLabel: string
  init: string[]
  loop: string[]
  terminate: string[]
}

/** Optional per-cell field for visualisation (pheromone, 3D slice, …). */
export interface PlanField {
  kind: 'pheromone' | 'sampled'
  width: number
  height: number
  values: Float32Array
  max: number
}

export interface PlanResult {
  status: PlanStatus
  continuous: boolean
  path: Point[]
  rawPath: Point[]
  /**
   * Same route in 3D, for voxel / field spaces. The 2D UI ignores it; keeping
   * it on the result means a 3D view can be added without changing the solver
   * contract or the wire format.
   */
  path3?: Array<{ x: number; y: number; z: number }>
  events: SearchEvent[]
  expanded: number
  expandedCells: number
  pathLength: number
  minClearance: number
  totalCost: number
  cost: CostBreakdown
  solveTime: number
  waypoints: number
  smoothed: boolean
  algorithmLabel: string
  openAtEnd: number
  solver?: string
  space?: SpaceKind
  trace?: TraceSpec
  field?: PlanField
  /** Honest note about settings this algorithm ignores, surfaced in the UI. */
  note?: string
  /**
   * Why there is no answer, when the reason is not the geometry.
   *
   * `status: 'infeasible'` currently means "the search failed", and the UI
   * diagnoses it as obstacles being too tight. Some failures have nothing to do
   * with the scene — an algorithm that only exists in 2D cannot solve a 3D
   * volume no matter how the cards are set. Tagging the cause lets the bottom
   * bar say the true thing instead of sending the user to tune a radius.
   */
  reason?: 'unsupported'
  /** Discrete iteration counter (generations, ant rounds, IDA* passes…). */
  rounds?: number
  /** Where the answer came from; the UI shows this next to the solve time. */
  transport?: 'inline' | 'worker' | 'http'
}

export interface RecipeSnapshot {
  mapId: MapId
  cards: CardsState
}