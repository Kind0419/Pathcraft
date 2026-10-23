/**
 * Genetic algorithm over path waypoints.
 *
 * A genome is not a walk on the grid: it is a fixed number of offsets from the
 * straight start→goal chord. Crossover blends two parents gene by gene, mutation
 * jitters a waypoint, and a colliding path is punished hard instead of repaired,
 * so the population learns to avoid walls on its own.
 */
import type { CardId, CardsState, GridMap, PlanResult, Point } from '../types'
import {
  evaluateContinuousPath,
  segmentClear,
  totalOf,
} from '../core/costs'
import { makeRng, resample } from '../core/geometry'
import {
  buildFailure,
  buildSuccess,
  stepProgress,
  tunedValue,
  type ProgressFn,
} from './shared'
import { planSampling } from './sampling'
import { SOLVER_BY_ID, type SolverSpec } from './registry'

interface Individual {
  genes: Float64Array
  fitness: number
  path: Point[]
}

export function planGa(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
  onProgress?: ProgressFn,
): PlanResult {
  const startedAt = performance.now()
  const popSize = Math.max(6, Math.round(tunedValue(cards, order, 'swarmWidth', 30)))
  const generations = Math.max(4, Math.round(tunedValue(cards, order, 'iterations', 32)))
  const rng = makeRng(0x1f83d9ab)

  const start: Point = { x: map.start.x + 0.5, y: map.start.y + 0.5 }
  const goal: Point = { x: map.goal.x + 0.5, y: map.goal.y + 0.5 }
  const span = Math.hypot(goal.x - start.x, goal.y - start.y)
  const waypoints = Math.max(2, Math.min(6, Math.round(span / 2.2)))
  const geneCount = waypoints * 2

  const base = Array.from({ length: waypoints }, (_, index) => {
    const t = (index + 1) / (waypoints + 1)
    return { x: start.x + (goal.x - start.x) * t, y: start.y + (goal.y - start.y) * t }
  })

  const gauss = () => {
    const u = Math.max(1e-9, rng())
    const v = rng()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  const decode = (genes: Float64Array): Point[] => {
    const points: Point[] = [{ ...start }]
    for (let i = 0; i < waypoints; i += 1) {
      points.push({
        x: Math.max(1, Math.min(map.width - 1, base[i].x + genes[i * 2])),
        y: Math.max(1, Math.min(map.height - 1, base[i].y + genes[i * 2 + 1])),
      })
    }
    points.push({ ...goal })
    return points
  }

  const score = (genes: Float64Array): Individual => {
    const path = decode(genes)
    let blocked = 0
    for (let i = 1; i < path.length; i += 1) {
      if (!segmentClear(map, cards, path[i - 1], path[i])) blocked += 1
    }
    if (blocked > 0) {
      return { genes, fitness: 6000 + blocked * 900, path }
    }
    const cost = totalOf(evaluateContinuousPath(map, cards, path))
    return { genes, fitness: cost, path }
  }

  // Seeding matters: random waypoints through a cluttered map are almost all
  // colliding, and a GA with no feasible individual has nothing to select on.
  // One quick RRT run gives every individual a feasible starting route.
  const seedResult = planSampling(map, cards, [], SOLVER_BY_ID.rrt)
  const seedPoints =
    seedResult.status === 'success'
      ? resample(seedResult.rawPath, waypoints + 2).slice(1, waypoints + 1)
      : null

  let population: Individual[] = []
  for (let i = 0; i < popSize; i += 1) {
    const genes = new Float64Array(geneCount)
    if (seedPoints) {
      const spread = 0.12 + rng() * 0.4
      for (let w = 0; w < waypoints; w += 1) {
        genes[w * 2] = seedPoints[w].x - base[w].x + gauss() * spread
        genes[w * 2 + 1] = seedPoints[w].y - base[w].y + gauss() * spread
      }
    } else if (i >= popSize / 3) {
      for (let g = 0; g < geneCount; g += 1) genes[g] = gauss() * 1.35
    }
    population.push(score(genes))
  }

  const events: PlanResult['events'] = []
  const bestSoFar = { path: [] as Point[], fitness: Number.POSITIVE_INFINITY }
  let expanded = 0
  let generation = 0
  let improved = 0

  const sorted = () => [...population].sort((a, b) => a.fitness - b.fitness)

  for (; generation < generations; generation += 1) {
    const ranked = sorted()
    if (ranked[0].fitness < bestSoFar.fitness) {
      bestSoFar.fitness = ranked[0].fitness
      bestSoFar.path = ranked[0].path
      improved += 1
    }
    if (bestSoFar.path.length > 1) {
      const stride = Math.max(1, Math.ceil(bestSoFar.path.length / 26))
      for (let i = 0; i < bestSoFar.path.length; i += stride) {
        const point = bestSoFar.path[i]
        events.push({
          x: point.x,
          y: point.y,
          g: bestSoFar.fitness,
          h: Math.hypot(point.x - goal.x, point.y - goal.y),
          f: bestSoFar.fitness + Math.hypot(point.x - goal.x, point.y - goal.y),
          openSize: popSize,
        })
      }
    }

    stepProgress(onProgress, (generation + 1) / generations)
    const next: Individual[] = [ranked[0], ranked[1]]
    while (next.length < popSize) {
      const parentA = ranked[Math.floor(rng() * Math.min(6, ranked.length))]
      const parentB = ranked[Math.floor(rng() * Math.min(8, ranked.length))]
      const genes = new Float64Array(geneCount)
      const blend = 0.25 + rng() * 0.5
      for (let g = 0; g < geneCount; g += 1) {
        genes[g] = parentA.genes[g] * blend + parentB.genes[g] * (1 - blend)
      }
      const mutations = 1 + Math.floor(rng() * 2)
      for (let m = 0; m < mutations; m += 1) {
        if (rng() > 0.55) continue
        const g = Math.floor(rng() * geneCount)
        genes[g] += gauss() * 0.65
      }
      next.push(score(genes))
      expanded += 1
    }
    population = next
  }

  const ranked = sorted()
  if (ranked[0].fitness < bestSoFar.fitness) {
    bestSoFar.fitness = ranked[0].fitness
    bestSoFar.path = ranked[0].path
  }

  const trace = {
    kind: 'meta' as const,
    loopLabel: `FOR gen < ${generations}`,
    init: [`P ← ${popSize} 条路径 · 基因 = ${waypoints} 个偏移`, '适应度 = 路径代价 + 碰撞罚分'],
    loop: ['锦标赛选择 → 混合交叉', '变异：抖动一个路径点', '精英保留 2 条'],
    terminate: ['return argmin fitness'],
  }

  const feasible = bestSoFar.path.length > 1 && bestSoFar.fitness < 6000
  const note = `GA 只优化 ${waypoints} 个路径点的位置：${popSize} 个体 × ${generations} 代，不保证最优；启发式、邻域与转角约束不适用。`

  if (!feasible) {
    return buildFailure({
      map,
      cards,
      order,
      startedAt,
      solver: spec.id,
      label: spec.label,
      space: 'sampling2d',
      continuous: true,
      trace,
      events,
      expanded,
      expandedCells: events.length,
      openAtEnd: popSize,
      rounds: generation,
      note,
    })
  }

  return buildSuccess({
    map,
    cards,
    order,
    rawPath: bestSoFar.path,
    startedAt,
    solver: spec.id,
    label: spec.label,
    space: 'sampling2d',
    continuous: true,
    trace,
    events,
    expanded,
    expandedCells: events.length,
    openAtEnd: popSize,
    rounds: generation,
    note,
    skipLineOfSight: false,
  })
}
