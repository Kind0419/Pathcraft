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

export interface PlanResult {
  status: PlanStatus
  path: Point[]
  rawPath: Point[]
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
}

export interface RecipeSnapshot {
  mapId: MapId
  cards: CardsState
}