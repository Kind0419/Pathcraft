/// <reference lib="webworker" />
/**
 * Solver worker.
 *
 * Heavy solvers (PRM, visibility graph, IDA*, ACO, GA) run here so dragging a
 * slider never freezes the canvas. The message contract is in
 * `src/lib/runtime/protocol.ts` and is transport-agnostic: the same request can
 * be POSTed to a server later without changing a solver.
 */
import { solveWith } from '../lib/solvers'
import { solverFor } from '../lib/solvers/registry'
import {
  PROTOCOL_VERSION,
  decodeSpace,
  type SolveRequest,
  type WorkerInbound,
  type WorkerOutbound,
} from '../lib/runtime/protocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

function post(message: WorkerOutbound) {
  ctx.postMessage(message)
}

ctx.onmessage = (event: MessageEvent<WorkerInbound>) => {
  const data = event.data
  if (data.kind !== 'solve') return
  const request: SolveRequest = data.request
  if (request.version !== PROTOCOL_VERSION) {
    post({ kind: 'error', id: request.id, message: '协议版本不匹配，请刷新页面' })
    return
  }
  const startedAt = performance.now()
  try {
    const space = decodeSpace(request.space)
    if (space.kind !== 'grid2d') {
      // The 3D and continuous spaces are routed to a server on purpose: a voxel
      // volume big enough to matter does not fit in a single-threaded worker.
      post({
        kind: 'error',
        id: request.id,
        message: `${space.kind} 需要在求解服务上运行（VITE_SOLVER_ENDPOINT）`,
      })
      return
    }
    const map = space.map
    const spec = solverFor(request.cards)
    const result = solveWith(spec, map, request.cards, request.order, (fraction) => {
      post({ kind: 'progress', id: request.id, fraction })
    })
    result.transport = 'worker'
    post({
      kind: 'result',
      id: request.id,
      result,
      elapsed: performance.now() - startedAt,
    })
  } catch (error) {
    post({
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
