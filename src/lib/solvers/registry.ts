/**
 * One table describing every solver: what it can honour, how heavy it is, and
 * how its run is drawn in the flow panel.
 *
 * The `ignores` list is not cosmetic. Several classical algorithms genuinely
 * cannot express a turn penalty or a non-uniform step cost — JPS needs uniform
 * costs to keep its pruning rules valid, and D* Lite searches cell states, so it
 * has no incoming direction to apply a turn to. The UI marks those cards as
 * "不适用" instead of silently pretending the setting did something.
 */
import type { CardId, CardsState } from '../types'

export type SolverFamily = 'graph' | 'improved' | 'sampling' | 'meta'

export type SolverId =
  | 'astar'
  | 'dijkstra'
  | 'greedy'
  | 'bfs'
  | 'dfs'
  | 'weighted'
  | 'rrt'
  | 'rrtstar'
  | 'prm'
  | 'visibility'
  | 'jps'
  | 'ida'
  | 'bidirectional'
  | 'beam'
  | 'dstar'
  | 'aco'
  | 'ga'

export interface SolverSpec {
  id: SolverId
  /** Position in the strategy card. Kept stable so shared URLs keep working. */
  value: number
  label: string
  en: string
  family: SolverFamily
  /** Searches continuous 2D space (float points) instead of cells. */
  continuous: boolean
  /** Encodes incoming direction, so turn / maxTurn / noUTurn are meaningful. */
  directional: boolean
  costModel: 'full' | 'distance' | 'uniform'
  /** Runs off the main thread; the UI shows a progress line while it works. */
  heavy: boolean
  /** Allowed to take part in the parameter feasibility scan. */
  scan: boolean
  ignores: CardId[]
  /** What the algorithm adds, in one sentence, for the library and inspector. */
  blurb: string
  blurbEn: string
}

/**
 * Which solvers can run outside a 2D cell grid.
 *
 * Only the six plain graph engines (they go through the dimension-agnostic
 * `searchLattice`) and the two sampling planners. Everything else is a 2D
 * implementation on purpose: JPS's pruning, IDA*'s move ordering, D* Lite's
 * incremental repair and the metaheuristics were all built and published against
 * the 2D engine. Claiming they work in 3D would be a lie the UI could not back
 * up, so a 3D world disables them instead of silently substituting A*.
 */
const SPATIAL_SOLVERS: ReadonlySet<SolverId> = new Set<SolverId>([
  'astar',
  'dijkstra',
  'greedy',
  'bfs',
  'dfs',
  'weighted',
  'rrt',
  'rrtstar',
])

export function supportsDim(spec: SolverSpec, dim: 2 | 3): boolean {
  return dim === 2 || SPATIAL_SOLVERS.has(spec.id)
}

export const SOLVERS: SolverSpec[] = [
  {
    id: 'astar',
    value: 0,
    label: 'A*',
    en: 'A*',
    family: 'graph',
    continuous: false,
    directional: true,
    costModel: 'full',
    heavy: false,
    scan: true,
    ignores: [],
    blurb: '最优且完备，启发式决定扩展多少节点。',
    blurbEn: 'Optimal when the heuristic is admissible; the heuristic decides how much it expands.',
  },
  {
    id: 'dijkstra',
    value: 1,
    label: 'Dijkstra',
    en: 'Dijkstra',
    family: 'graph',
    continuous: false,
    directional: true,
    costModel: 'full',
    heavy: false,
    scan: true,
    ignores: [],
    blurb: '按 g 均匀铺开，用作代价最优的参照。',
    blurbEn: 'Uniform expansion by g; the reference for cost optimality.',
  },
  {
    id: 'greedy',
    value: 2,
    label: '贪心最佳优先',
    en: 'Greedy best-first',
    family: 'graph',
    continuous: false,
    directional: true,
    costModel: 'full',
    heavy: false,
    scan: true,
    ignores: [],
    blurb: '只看离终点多远，快但容易卡在凹槽里。',
    blurbEn: 'Orders by distance to goal only: fast, and easy to trap in a notch.',
  },
  {
    id: 'bfs',
    value: 3,
    label: 'BFS',
    en: 'BFS',
    family: 'graph',
    continuous: false,
    directional: true,
    costModel: 'full',
    heavy: false,
    scan: true,
    ignores: [],
    blurb: '按步数先进先出，等代价图上的最短跳数。',
    blurbEn: 'FIFO by hop count; fewest hops on an unweighted graph.',
  },
  {
    id: 'dfs',
    value: 4,
    label: 'DFS',
    en: 'DFS',
    family: 'graph',
    continuous: false,
    directional: true,
    costModel: 'full',
    heavy: false,
    scan: true,
    ignores: [],
    blurb: '后进先出，会一路钻到底再回头。',
    blurbEn: 'LIFO: dives to the end before backtracking.',
  },
  {
    id: 'weighted',
    value: 5,
    label: '加权 A* 1.50×',
    en: 'Weighted A* 1.50×',
    family: 'graph',
    continuous: false,
    directional: true,
    costModel: 'full',
    heavy: false,
    scan: true,
    ignores: [],
    blurb: '放大启发式换取速度，路径可能略长。',
    blurbEn: 'Inflates the heuristic for speed at the cost of optimality.',
  },
  {
    id: 'rrt',
    value: 6,
    label: 'RRT',
    en: 'RRT',
    family: 'sampling',
    continuous: true,
    directional: false,
    costModel: 'distance',
    heavy: false,
    scan: false,
    ignores: ['heuristic', 'diagonal', 'cornerCut', 'noUTurn', 'maxTurn'],
    blurb: '随机生长一棵树，快但路径抖。',
    blurbEn: 'Grows a random tree: fast, and visibly wobbly.',
  },
  {
    id: 'rrtstar',
    value: 7,
    label: 'RRT*',
    en: 'RRT*',
    family: 'sampling',
    continuous: true,
    directional: false,
    costModel: 'distance',
    heavy: false,
    scan: false,
    ignores: ['heuristic', 'diagonal', 'cornerCut', 'noUTurn', 'maxTurn'],
    blurb: '带重连的 RRT，采样越多路径越短。',
    blurbEn: 'RRT with rewiring; more samples buy a shorter path.',
  },
  {
    id: 'prm',
    value: 8,
    label: 'PRM',
    en: 'PRM',
    family: 'sampling',
    continuous: true,
    directional: false,
    costModel: 'distance',
    heavy: true,
    scan: false,
    ignores: ['heuristic', 'diagonal', 'cornerCut', 'noUTurn', 'maxTurn'],
    blurb: '先建路线图再查最短路，适合反复查询。',
    blurbEn: 'Builds a roadmap, then queries it; good for repeated queries.',
  },
  {
    id: 'visibility',
    value: 9,
    label: '可见性图',
    en: 'Visibility graph',
    family: 'sampling',
    continuous: true,
    directional: false,
    costModel: 'distance',
    heavy: true,
    scan: false,
    ignores: ['heuristic', 'diagonal', 'cornerCut', 'noUTurn', 'maxTurn'],
    blurb: '把可互视的顶点连成图，路径贴着障碍拐角。',
    blurbEn: 'Links mutually visible vertices; paths hug obstacle corners.',
  },
  {
    id: 'jps',
    value: 10,
    label: 'JPS',
    en: 'JPS',
    family: 'improved',
    continuous: false,
    directional: false,
    costModel: 'uniform',
    heavy: false,
    scan: true,
    ignores: [
      'clearance',
      'turn',
      'lengthWeight',
      'diagonalBias',
      'maxTurn',
      'noUTurn',
      'cornerCut',
      'diagonal',
    ],
    blurb: '跳过对称路径上的中间点，只保留跳跃点。',
    blurbEn: 'Skips symmetric stretches and keeps only jump points.',
  },
  {
    id: 'ida',
    value: 11,
    label: 'IDA*',
    en: 'IDA*',
    family: 'improved',
    continuous: false,
    directional: true,
    costModel: 'full',
    heavy: true,
    scan: true,
    ignores: [],
    blurb: '按 f 阈值逐轮加深，几乎不占内存。',
    blurbEn: 'Deepens on an f threshold; near-constant memory.',
  },
  {
    id: 'bidirectional',
    value: 12,
    label: '双向 A*',
    en: 'Bidirectional A*',
    family: 'improved',
    continuous: false,
    directional: false,
    costModel: 'distance',
    heavy: false,
    scan: true,
    ignores: ['turn', 'maxTurn', 'noUTurn'],
    blurb: '两端同时扩张，在中途相遇。',
    blurbEn: 'Expands from both ends and meets in the middle.',
  },
  {
    id: 'beam',
    value: 13,
    label: 'Beam 搜索',
    en: 'Beam search',
    family: 'improved',
    continuous: false,
    directional: true,
    costModel: 'full',
    heavy: false,
    scan: true,
    ignores: [],
    blurb: '每层只留固定宽度的候选，快但会剪掉正解。',
    blurbEn: 'Keeps a fixed-width frontier per layer: fast, and able to prune the answer.',
  },
  {
    id: 'dstar',
    value: 14,
    label: 'D* Lite',
    en: 'D* Lite',
    family: 'improved',
    continuous: false,
    directional: false,
    costModel: 'distance',
    heavy: false,
    scan: true,
    ignores: ['turn', 'maxTurn', 'noUTurn'],
    blurb: '从终点反算，起点变化时复用上一轮结果。',
    blurbEn: 'Searches backwards from the goal and reuses the last run when the start moves.',
  },
  {
    id: 'aco',
    value: 15,
    label: '蚁群 ACO',
    en: 'Ant colony',
    family: 'meta',
    continuous: false,
    directional: false,
    costModel: 'distance',
    heavy: true,
    scan: false,
    ignores: ['turn', 'maxTurn', 'noUTurn', 'heuristic'],
    blurb: '信息素随路径长度累积，一轮轮逼近更短的路线。',
    blurbEn: 'Pheromone accumulates along short routes; each round bends toward a better path.',
  },
  {
    id: 'ga',
    value: 16,
    label: '遗传算法',
    en: 'Genetic algorithm',
    family: 'meta',
    continuous: true,
    directional: false,
    costModel: 'distance',
    heavy: true,
    scan: false,
    ignores: ['heuristic', 'diagonal', 'cornerCut', 'noUTurn', 'maxTurn'],
    blurb: '把路径当作染色体，靠交叉和变异逐代改进。',
    blurbEn: 'Treats a path as a chromosome and improves it by crossover and mutation.',
  },
]

export const SOLVER_BY_VALUE: SolverSpec[] = [...SOLVERS].sort(
  (a, b) => a.value - b.value,
)

export const SOLVER_BY_ID: Record<SolverId, SolverSpec> = Object.fromEntries(
  SOLVERS.map((solver) => [solver.id, solver]),
) as Record<SolverId, SolverSpec>

export const FAMILIES: Array<{
  id: SolverFamily
  label: string
  labelEn: string
  hint: string
  hintEn: string
}> = [
  { id: 'graph', label: '图搜索', labelEn: 'Graph', hint: '队列顺序', hintEn: 'queue order' },
  {
    id: 'improved',
    label: '改进搜索',
    labelEn: 'Improved',
    hint: '剪枝与增量',
    hintEn: 'pruning & reuse',
  },
  { id: 'sampling', label: '采样', labelEn: 'Sampling', hint: '连续空间', hintEn: 'continuous' },
  {
    id: 'meta',
    label: '元启发式',
    labelEn: 'Metaheuristic',
    hint: '随机迭代',
    hintEn: 'stochastic',
  },
]

export function strategyValue(cards: CardsState): number {
  return cards.strategy.enabled ? Math.round(cards.strategy.value) : 0
}

export function solverFor(cards: CardsState): SolverSpec {
  const value = strategyValue(cards)
  return SOLVER_BY_VALUE[value] ?? SOLVER_BY_VALUE[0]
}

/**
 * New cards only make sense for a subset of solvers. Everything else is
 * driven by the `ignores` list.
 *
 * The algorithm-internal knobs are narrowed here rather than added to every
 * solver's `ignores` array: they are not "this solver loses the ability", they
 * are "this solver does not have that parameter at all", and writing them once
 * keeps the table honest.
 */
export function cardApplies(cardId: CardId, solver: SolverSpec): boolean {
  if (cardId === 'swarmWidth') {
    return solver.id === 'beam' || solver.id === 'aco' || solver.id === 'ga'
  }
  if (cardId === 'iterations') {
    return solver.id === 'aco' || solver.id === 'ga'
  }
  if (cardId === 'incremental') {
    return solver.id === 'dstar'
  }
  if (cardId === 'sampleStep' || cardId === 'goalBias') {
    return solver.id === 'rrt' || solver.id === 'rrtstar'
  }
  if (cardId === 'rewireRadius') return solver.id === 'rrtstar'
  if (cardId === 'connectRadius') return solver.id === 'prm'
  if (cardId === 'evaporate' || cardId === 'beta') return solver.id === 'aco'
  if (cardId === 'mutate') return solver.id === 'ga'
  if (cardId === 'strategy') return true
  return !solver.ignores.includes(cardId)
}

export function ignoredCards(solver: SolverSpec): CardId[] {
  return solver.ignores
}

/**
 * Cards that change how a solver behaves even though they are not in the
 * recipe yet. Used by the inspector to offer a one-click "add".
 */
export function optionalCards(solver: SolverSpec): CardId[] {
  if (solver.id === 'beam') return ['swarmWidth']
  if (solver.id === 'aco') return ['swarmWidth', 'iterations', 'evaporate', 'beta']
  if (solver.id === 'ga') return ['swarmWidth', 'iterations', 'mutate']
  if (solver.id === 'dstar') return ['incremental']
  if (solver.id === 'rrt') return ['sampleStep', 'goalBias']
  if (solver.id === 'rrtstar') return ['sampleStep', 'goalBias', 'rewireRadius']
  if (solver.id === 'prm') return ['connectRadius']
  return []
}
