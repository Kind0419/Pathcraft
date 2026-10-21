import { CARD_BY_ID } from './cards'
import { plan } from './planner'
import type { CardId, CardsState, GridMap } from './types'

export interface FeasibilitySpan {
  from: number
  to: number
  feasible: boolean
}

export interface FeasibilityScan {
  points: Array<{ value: number; feasible: boolean }>
  spans: FeasibilitySpan[]
  min: number
  max: number
  currentFeasible: boolean
}

/**
 * Sample a parameter and record whether the planner returns a path.
 * Deliberately does NOT clamp the slider: the feasible set can be
 * non-monotonic (feasible → infeasible → feasible).
 */
export function scanFeasibility(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  id: CardId,
  samples = 31,
): FeasibilityScan | null {
  const def = CARD_BY_ID[id]
  if (!def || def.kind === 'toggle') return null

  const values: number[] = []
  if (def.kind === 'choice') {
    const count = def.options?.length ?? 1
    for (let i = 0; i < count; i += 1) values.push(i)
  } else {
    const min = def.min ?? 0
    const max = def.max ?? 1
    const steps = Math.max(8, samples - 1)
    for (let i = 0; i <= steps; i += 1) {
      values.push(min + ((max - min) * i) / steps)
    }
  }

  const current = cards[id].value
  if (!values.some((value) => Math.abs(value - current) < 1e-9)) {
    values.push(current)
    values.sort((a, b) => a - b)
  }

  const points = values.map((value) => {
    const next: CardsState = {
      ...cards,
      [id]: { enabled: true, value },
    }
    const result = plan(map, next, order)
    return { value, feasible: result.status === 'success' }
  })

  const spans: FeasibilitySpan[] = []
  for (const point of points) {
    const last = spans[spans.length - 1]
    if (last && last.feasible === point.feasible) {
      last.to = point.value
    } else {
      spans.push({
        from: point.value,
        to: point.value,
        feasible: point.feasible,
      })
    }
  }

  return {
    points,
    spans,
    min: values[0] ?? 0,
    max: values[values.length - 1] ?? 1,
    currentFeasible: points.find(
      (point) => Math.abs(point.value - current) < 1e-9,
    )?.feasible ?? false,
  }
}