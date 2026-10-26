/**
 * Do the tunable cards actually tune anything?
 *
 * The product rule for a parameter card is blunt: it has to change the answer.
 * A switch that only turns a label in the inspector is worse than no switch,
 * because it teaches the user a false model of the algorithm. So each of the
 * eight knobs gets run at three settings against a fixed map and a fixed seed,
 * and the results have to differ in at least one measured quantity.
 *
 * Fixed seeds matter: RRT, ACO and GA are stochastic, so a difference here can
 * only come from the parameter, never from a different draw.
 */
import { createDefaultCards, createDefaultRecipeOrder, CARD_BY_ID } from '../src/lib/cards'
import { MAPS } from '../src/lib/maps'
import { plan } from '../src/lib/planner'
import { SOLVER_BY_ID, cardApplies, optionalCards, type SolverId } from '../src/lib/solvers/registry'
import type { CardId, CardsState } from '../src/lib/types'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

interface Trial {
  card: CardId
  solver: SolverId
  values: number[]
  /** Which of the three maps the trial runs on. */
  map?: number
}

// Map choice is part of the experiment, not a detail. ACO's pheromone settings
// only change the *route* where more than one corridor is competitive — on a
// single-corridor map the colony converges to the same path for any ρ, and the
// knob looks decorative when it is merely untested. So the two ACO trials run
// on the clutter map on purpose.
const TRIALS: Trial[] = [
  { card: 'sampleStep', solver: 'rrt', values: [0.8, 1.7, 3.0] },
  { card: 'goalBias', solver: 'rrt', values: [0, 0.12, 0.5] },
  { card: 'rewireRadius', solver: 'rrtstar', values: [1, 2.6, 5.5] },
  { card: 'connectRadius', solver: 'prm', values: [1.5, 4, 8] },
  { card: 'evaporate', solver: 'aco', values: [0.05, 0.28, 0.7], map: 2 },
  { card: 'beta', solver: 'aco', values: [0, 3, 7], map: 2 },
  { card: 'mutate', solver: 'ga', values: [0, 0.55, 1] },
  // EGO's three knobs. s_f and λ_s change the curve itself; v_max changes only
  // the timetable, which is why the harness compares `duration` as well.
  { card: 'egoSafety', solver: 'ego', values: [0, 2, 4], map: 2 },
  { card: 'egoSmooth', solver: 'ego', values: [0.2, 1, 8], map: 2 },
  { card: 'egoSpeed', solver: 'ego', values: [0.8, 2.4, 5], map: 2 },
]

function run(card: CardId, solver: SolverId, value: number, mapIndex = 0) {
  const map = MAPS[mapIndex]
  const cards: CardsState = createDefaultCards()
  const spec = SOLVER_BY_ID[solver]
  cards.strategy = { enabled: true, value: spec.value }
  cards[card] = { enabled: true, value }
  const order = [...createDefaultRecipeOrder(), card]
  const result = plan(map, cards, order)
  return {
    status: result.status,
    length: result.pathLength,
    expanded: result.expanded,
    rounds: result.rounds ?? 0,
    waypoints: result.waypoints,
    duration: result.duration ?? 0,
    open: result.openAtEnd,
    ms: result.solveTime,
  }
}

function same(a: ReturnType<typeof run>, b: ReturnType<typeof run>) {
  return (
    a.status === b.status &&
    Math.abs(a.length - b.length) < 1e-6 &&
    a.expanded === b.expanded &&
    a.rounds === b.rounds &&
    a.waypoints === b.waypoints &&
    Math.abs(a.duration - b.duration) < 1e-6
  )
}

console.log('fixed seeds; each knob at three settings\n')

for (const trial of TRIALS) {
  const spec = SOLVER_BY_ID[trial.solver]
  const def = CARD_BY_ID[trial.card]
  check(
    `${trial.card} is offered for ${spec.en}`,
    cardApplies(trial.card, spec) && optionalCards(spec).includes(trial.card),
  )

  const rows = trial.values.map((value) => ({
    value,
    out: run(trial.card, trial.solver, value, trial.map ?? 0),
  }))
  for (const row of rows) {
    const o = row.out
    console.log(
      `      ${def.param} = ${row.value.toFixed(2).padStart(5)}  ` +
        `${o.status === 'success' ? `${o.length.toFixed(2)} m` : 'infeasible'}` +
        `  expanded ${String(o.expanded).padStart(6)}` +
        `  rounds ${String(o.rounds).padStart(3)}` +
        `  pts ${String(o.waypoints).padStart(3)}` +
        `  t ${o.duration.toFixed(2)}s` +
        `  ${o.ms.toFixed(0)} ms`,
    )
  }
  const distinct = rows.filter(
    (row, index) => rows.findIndex((other) => same(row.out, other.out)) === index,
  )
  check(
    `${trial.card} on ${MAPS[trial.map ?? 0].name} changes the answer` +
      ` (${distinct.length} distinct result${distinct.length === 1 ? '' : 's'} of ${rows.length})`,
    distinct.length > 1,
  )
}

/* A card outside its solver has to be honest about it. */
for (const [card, solver] of [
  ['sampleStep', 'astar'],
  ['evaporate', 'rrt'],
  ['connectRadius', 'aco'],
] as Array<[CardId, SolverId]>) {
  check(
    `${card} is marked n/a on ${SOLVER_BY_ID[solver].en}`,
    !cardApplies(card, SOLVER_BY_ID[solver]),
  )
}

console.log(failures === 0 ? '\nall knobs are live' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
