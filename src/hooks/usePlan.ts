/**
 * One hook owns "what is currently on screen".
 *
 * Fast solvers resolve during render (no flicker). Heavy ones resolve in the
 * worker: the previous answer stays visible until the new one lands, and stale
 * replies are dropped. That keeps dragging a slider smooth even when the
 * selected algorithm needs a few hundred milliseconds.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { solverFor, type SolverSpec } from '../lib/solvers/registry'
import { solveWith } from '../lib/solvers'
import { solveRemote, type SolveTransport } from '../lib/runtime/solverClient'
import type { CardId, CardsState, GridMap, PlanResult } from '../lib/types'

interface CachedResult {
  map: GridMap
  cards: CardsState
  order: CardId[]
  result: PlanResult
}

export interface PlanState {
  result: PlanResult
  solver: SolverSpec
  pending: boolean
  progress: number
  transport: SolveTransport
  error: string | null
}

export function usePlan(map: GridMap, cards: CardsState, order: CardId[]): PlanState {
  const solver = solverFor(cards)
  const [pending, setPending] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [, setRevision] = useState(0)
  const cacheRef = useRef<CachedResult | null>(null)

  const inline = useMemo(
    () => (solver.heavy ? null : solveWith(solver, map, cards, order)),
    [solver, map, cards, order],
  )

  useEffect(() => {
    if (!solver.heavy) {
      setPending(false)
      setProgress(0)
      setError(null)
      return
    }
    let active = true
    setPending(true)
    setProgress(0)
    setError(null)
    const job = solveRemote(map, cards, order, (fraction) => {
      if (active) setProgress(fraction)
    })
    job.promise
      .then((outcome) => {
        if (!active) return
        cacheRef.current = { map, cards, order, result: outcome.result }
        setPending(false)
        setProgress(1)
        setRevision((value) => value + 1)
      })
      .catch((reason: unknown) => {
        if (!active) return
        setPending(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      active = false
      job.cancel()
    }
  }, [solver, map, cards, order])

  if (inline) {
    cacheRef.current = { map, cards, order, result: inline }
    return { result: inline, solver, pending: false, progress: 0, transport: 'inline', error: null }
  }

  const cached = cacheRef.current
  const matches =
    cached && cached.map === map && cached.cards === cards && cached.order === order

  // A heavy job is in flight. Keep the last frame on screen instead of blocking
  // the main thread; only a cold start has nothing to show yet.
  if (!matches) {
    if (cached) {
      return {
        result: cached.result,
        solver,
        pending,
        progress,
        transport: cached.result.transport ?? 'worker',
        error,
      }
    }
    const initial = solveWith(solver, map, cards, order)
    cacheRef.current = { map, cards, order, result: initial }
    return { result: initial, solver, pending, progress, transport: 'worker', error }
  }

  return {
    result: cached.result,
    solver,
    pending,
    progress,
    transport: cached.result.transport === 'http' ? 'http' : 'worker',
    error,
  }
}
