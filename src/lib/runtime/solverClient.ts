/**
 * Client for the solver runtime.
 *
 * Routing rule: light solvers never leave the main thread (a 2 ms solve is not
 * worth a round-trip), heavy ones always do. Set `VITE_SOLVER_ENDPOINT` to send
 * every job to a server instead; the payload is identical, only the envelope
 * changes, so a backend can be dropped in without touching solver code.
 */
import SolverWorker from '../../workers/solver.worker?worker&inline'
import type { CardId, CardsState, GridMap, PlanResult } from '../types'
import {
  PROTOCOL_VERSION,
  gridSpace,
  resultFromJson,
  spaceToJson,
  type SolveRequest,
  type WorkerOutbound,
} from './protocol'

export type SolveTransport = 'inline' | 'worker' | 'http'

export interface SolveOutcome {
  result: PlanResult
  transport: SolveTransport
  elapsed: number
}

interface PendingJob {
  resolve: (outcome: SolveOutcome) => void
  reject: (error: Error) => void
  onProgress?: (fraction: number) => void
  cancelled: boolean
}

let worker: Worker | null = null
let sequence = 0
const jobs = new Map<number, PendingJob>()

function endpoint(): string | null {
  const value = import.meta.env?.VITE_SOLVER_ENDPOINT
  return typeof value === 'string' && value.length > 0 ? value : null
}

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new SolverWorker()
  worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
    const message = event.data
    const job = jobs.get(message.id)
    if (!job) return
    if (message.kind === 'progress') {
      job.onProgress?.(message.fraction)
      return
    }
    jobs.delete(message.id)
    if (job.cancelled) return
    if (message.kind === 'error') {
      job.reject(new Error(message.message))
      return
    }
    job.resolve({ result: message.result, transport: 'worker', elapsed: message.elapsed })
  }
  worker.onerror = (event) => {
    const error = new Error(event.message || '后台求解线程异常')
    for (const [, job] of jobs) job.reject(error)
    jobs.clear()
    worker = null
  }
  return worker
}

async function solveViaHttp(
  request: SolveRequest,
  onProgress?: (fraction: number) => void,
): Promise<SolveOutcome> {
  const url = endpoint()
  if (!url) throw new Error('未配置求解服务地址')
  const startedAt = performance.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: request.version,
      id: request.id,
      space: spaceToJson(request.space),
      cards: request.cards,
      order: request.order,
    }),
  })
  if (!response.ok) throw new Error(`求解服务返回 ${response.status}`)
  const payload = (await response.json()) as { result?: unknown }
  onProgress?.(1)
  return {
    result: resultFromJson((payload.result ?? payload) as never),
    transport: 'http',
    elapsed: performance.now() - startedAt,
  }
}

export function solveRemote(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  onProgress?: (fraction: number) => void,
): { promise: Promise<SolveOutcome>; cancel: () => void } {
  sequence += 1
  const id = sequence
  const request: SolveRequest = {
    version: PROTOCOL_VERSION,
    id,
    space: gridSpace(map),
    cards,
    order,
  }

  let job: PendingJob | null = null
  const promise = new Promise<SolveOutcome>((resolve, reject) => {
    job = { resolve, reject, onProgress, cancelled: false }
    jobs.set(id, job)
  })

  if (endpoint()) {
    solveViaHttp(request, onProgress).then(
      (outcome) => {
        jobs.delete(id)
        if (!job?.cancelled) job?.resolve(outcome)
      },
      (error) => {
        jobs.delete(id)
        if (!job?.cancelled) job?.reject(error)
      },
    )
  } else {
    ensureWorker().postMessage({ kind: 'solve', request })
  }

  return {
    promise,
    cancel: () => {
      const current = jobs.get(id)
      if (current) current.cancelled = true
      jobs.delete(id)
      // A running solve cannot be interrupted mid-loop; dropping the reply is
      // enough, and the next request supersedes it.
      worker?.postMessage({ kind: 'cancel', id })
    },
  }
}
