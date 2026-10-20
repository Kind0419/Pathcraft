import { createDefaultCards } from '../src/lib/cards'
import { MAPS } from '../src/lib/maps'
import { plan } from '../src/lib/planner'

for (const map of MAPS) {
  const cards = createDefaultCards()
  const result = plan(map, cards)
  console.log(map.name, {
    status: result.status,
    expanded: result.expanded,
    events: result.events.length,
    path: result.path.length,
    lengthM: (result.pathLength * map.cellSize).toFixed(2),
    clearanceM: (result.minClearance * map.cellSize).toFixed(2),
    cost: result.totalCost.toFixed(2),
    solve: result.solveTime.toFixed(2),
    label: result.algorithmLabel,
  })
}

const map = MAPS[0]
for (const h of [0, 0.5, 1, 2]) {
  const cards = createDefaultCards()
  cards.heuristic.value = h
  const result = plan(map, cards)
  console.log(`h=${h}`, {
    expanded: result.expanded,
    path: result.path.length,
    lengthM: (result.pathLength * map.cellSize).toFixed(2),
    solve: result.solveTime.toFixed(2),
  })
}

for (const r of [0, 0.6, 1.15, 1.8, 2.2]) {
  const cards = createDefaultCards()
  cards.collision.value = r
  const result = plan(map, cards)
  console.log(`radius=${r}`, {
    status: result.status,
    expanded: result.expanded,
    clearanceM: (result.minClearance * map.cellSize).toFixed(2),
    lengthM: (result.pathLength * map.cellSize).toFixed(2),
  })
}

for (const smooth of [false, true]) {
  const cards = createDefaultCards()
  cards.smooth.enabled = smooth
  const result = plan(map, cards)
  console.log(`smooth=${smooth}`, {
    waypoints: result.waypoints,
    lengthM: (result.pathLength * map.cellSize).toFixed(2),
    clearanceM: (result.minClearance * map.cellSize).toFixed(2),
  })
}