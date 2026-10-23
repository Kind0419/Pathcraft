/**
 * Public planner entry point.
 *
 * The actual algorithms live in `src/lib/solvers/*`; this file only exists so
 * older imports (`plan`) and the worker share one dispatch path.
 */
export { plan, solveWith, solverFor } from './solvers'
export type { SolverId, SolverSpec } from './solvers/registry'
