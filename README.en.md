# Pathcraft

**An interactive, composable path-planning workbench.**  
Build path-planning algorithms from parameter cards and watch the search, execution trace, final path and metrics update live.

[中文](README.md) · [English](README.en.md)

[Live Demo](https://Kind0419.github.io/Pathcraft/) · [GitHub](https://github.com/Kind0419/Pathcraft) · [Changelog](CHANGELOG.md) · [MIT License](LICENSE)

> Status: `0.9.1` · 2D grid + continuous + 3D voxel / field · light / dark · React + TypeScript + Canvas

[![Pathcraft interactive demo](https://Kind0419.github.io/Pathcraft/preview-en.png?v=2)](https://Kind0419.github.io/Pathcraft/)

> GitHub README is static Markdown, so the app cannot run inside it. Click the screenshot above, or open <https://Kind0419.github.io/Pathcraft/> for the interactive version.

---

## What it is

Pathcraft is a path-planning workbench that runs in the browser, covering four spaces — **2D grids**, **2D and 3D continuous fields**, and **3D voxels** — behind one set of composable cards, one replay, and one set of metrics.

It decomposes planning into composable parameter modules:

- **Search**: 17 strategies — A*, Dijkstra, greedy best-first, BFS, DFS, weighted A*, JPS, IDA*, bidirectional A*, Beam, D* Lite; RRT, RRT*, PRM, visibility graph; ant colony (ACO), genetic algorithm
- **Cost**: clearance, turn, length, diagonal bias, goal tolerance
- **Constraints**: safety inflation, max turn, no U-turn, corner cut, expansion budget
- **Post-process**: line-of-sight straightening, Chaikin smoothing (passes), path thinning (tolerance)

Pick modules from the component library, tune values in the assembly table, and watch the search frontier, final path and previous path update in the canvas. The Flow tab maps the current replay frame to the actual execution branch and shows the queue, expanded states and each card's compile site. Selecting RRT / RRT* / PRM / Visibility graph switches the canvas to a continuous 2D space and outputs a smooth polyline.

---

## Features

- Eight scenes in three groups: Grid 2D (Notch, Gate, Clutter), Voxel 3D (Hangar, Shaft, Grove), Continuous (Round hall, Floating grove)
- Map-size editor: 24–72 columns × 18–56 rows, up to 4032 cells; keeps existing walls and safely relocates start/goal
- 2D map editing: draw / erase / brush 1·3·5 / clear / restore preset
- Grid mode: A* / Dijkstra / greedy / BFS / DFS / weighted A* / JPS / IDA* / bidirectional A* / Beam / D* Lite
- Continuous mode: RRT / RRT* / PRM / visibility graph with smooth continuous paths
- 3D view: orthographic (drag to orbit, scroll to zoom, reset); voxel worlds draw exposed faces only, the route is tinted by altitude, and columns really do occlude the route behind them
- 3D endpoints: dragging re-plans live and holds the current layer (hold Alt to change layer); an illegal or unreachable drop turns the marker into a warning
- Click or drag start and goal; markers slide along safe boundaries and snap to the nearest legal cell
- Search replay: play, pause, timeline, 0.5x / 1x / 2x; the route grows from start to goal as it runs
- Search / path / previous-path layer toggles
- Canvas zoom 80%–105%; mouse wheel or `− / +`
- Focus mode: hide both side panels and maximize the map
- Resizable left / right / bottom panels with auto-collapse
- Drag rows to reorder; cancel by dropping outside; text selection is disabled while dragging
- Component library grouped by Search / Cost / Constraints / Post-process, with parameter symbols
- Flow tab: draggable assembly chain + live execution trace (current node, g/h/f, open set, actual branches)
- Hover a card to highlight its code line in the Flow tab and its affected area on the canvas
- Parameter inspector scans and draws the feasible range; disjoint feasible sets are never locked out
- Metrics tab: cost donut + segmented bar + legend
- Infeasible runs explain the reason in the bottom strip and open the relevant parameter
- Share URL, export JSON / CSV
- Single-file offline build
- Chinese / English switch
- Light and dark themes: one toggle in the top bar, first visit follows the system preference; the canvases and the 3D stage switch with the UI instead of being an inversion of it

### Execution trace

The Flow tab is not a static diagram. It highlights the branch taken at the current replay frame and shows the current node, g / h / f, open set and expansion state. The assembly table below can be dragged to reorder; hovering a row highlights the affected area on the canvas.

![Pathcraft execution trace](https://Kind0419.github.io/Pathcraft/preview-flow-en.png?v=2)

### Continuous space

RRT / RRT* / PRM / Visibility graph turn search points into continuous samples and smooth the final path after collision checking. Map size, safety inflation and start/goal still apply.

![Pathcraft continuous planning](https://Kind0419.github.io/Pathcraft/preview-continuous-en.png?v=2)

### 3D

Voxel worlds and continuous fields share a single orthographic view: no WebGL and no three.js, just sorted quads and polylines, which is why the offline single-file build is still one file.

- **Voxel 3D**: exposed faces only, merged into one quad per run — a 30 x 21 floor becomes twenty-odd quads instead of six hundred. That is not only a saving: drawn cell by cell, the stroke that hides each seam adds up to a fine grid over the whole plate and the floor reads as tiling
- **One material, four tones**: floor, wall tops and two side orientations, all derived from a single hex. Four hand-picked colours turn the volume into a diagram with a legend; one material under one light reads as a solid. Wall tops also lift slightly with altitude, so two floor slabs separate without relying on position alone
- **Contact shadows**: every occupied column, and every floating sphere or slab, drops a soft shadow on the ground. Without one, columns and balls are stickers
- **Continuous fields**: obstacles are analytic primitives (spheres, boxes, capsules, discs) rasterised on demand at the current resolution; resolution is a runtime parameter, so the distance field can be rebuilt at any time
- **Altitude tint**: the route runs from pale sage (low) to amber (high). An orthographic view has no perspective, so without colour a climb and a stroll look identical. A ground projection of the route runs underneath it, so a climb visibly separates the line from its own shadow
- **Occlusion**: the route and the walls share one depth list, so a column genuinely hides the segment behind it; a very faint x-ray pass keeps the route from appearing to stop dead in front of the goal
- **Moving endpoints**: drag S or G directly, exactly as in 2D; or arm start/goal from the toolbar and click the scene. Picking walks the view ray, so a point can land on an upper floor rather than only the ground layer, and snaps to the nearest legal cell on release
- **Feel**: orbiting coasts to a stop after release, the wheel eases instead of stepping, and the reset tween takes the shortest way round (after a few spins it does not unwind them backwards)
- **Frame loop**: the camera lives in a ref and repaints from requestAnimationFrame, so a drag triggers no React render at all — which is what makes it track the hand
- **Sampling in 3D**: RRT and RRT* work here too — the tree lives in continuous coordinates, and the lattice is only a collision oracle

![Pathcraft 3D voxel planning](https://Kind0419.github.io/Pathcraft/preview-3d.png?v=1)

---

## Algorithm scope

Available in 3D: A*, Dijkstra, greedy, BFS, DFS, weighted A* (over a 26-neighbourhood lattice), plus RRT and RRT* (continuous tree with lattice collision checks). JPS, IDA*, D* Lite, bidirectional A*, Beam and the metaheuristics are 2D implementations; in a 3D scene they are marked "not applicable" rather than quietly swapped for A*.

### Grid graph search

| Strategy | Priority |
|---|---|
| A* | `g + h` |
| Weighted A* | `g + 1.5h` |
| Dijkstra | `g` |
| Greedy best-first | `h` |
| BFS | FIFO insertion order |
| DFS | LIFO order |

### Improved and incremental graph search

| Strategy | Method | Note |
|---|---|---|
| JPS | jump points + forced-neighbour pruning | pruning needs uniform step cost, so clearance / turn weights are not applied |
| IDA* | iterative deepening + transposition table + greedy upper bound | near-constant memory, may be slightly suboptimal |
| Bidirectional A* | alternate expansion from both ends, join at the optimal meeting point | searches cell states, so there is no incoming heading and the turn weight does not apply |
| Beam | keep only `w` candidates per layer | width comes from the "candidate width" card; fast, not optimal |
| D* Lite | maintain rhs/g backwards from the goal | reuses the distance field when start/goal move; turn "incremental reuse" off to force a rebuild |

### Continuous 2D space

| Strategy | Method |
|---|---|
| RRT | random sample + nearest neighbour + steer + collision check |
| RRT* | RRT + neighbourhood rewiring for shorter paths |
| PRM | sampled roadmap + k-nearest connections + Dijkstra |
| Visibility graph | free-space roadmap + 8-neighbour links + visible shortcuts + Dijkstra |

Continuous planners apply one line-of-sight shortcut pass, round corners where clearance allows, then honour the line-of-sight / Chaikin / thinning cards. Safety inflation is used for sampled points, edge collision and corner rounding.

### Metaheuristics

| Strategy | Method |
|---|---|
| Ant colony (ACO) | pheromone τ^α·η^β path construction, evaporate / deposit each round; the canvas shows the pheromone heat field |
| Genetic algorithm | seeded from an RRT path, 6 waypoints as genes, selection + crossover + perturbation, elitism |

Both take their round count from the "generations" card (20+ recommended). They improve with rounds and are not guaranteed optimal.

### "Not applicable" is stated, not hidden

Some parameters genuinely do nothing for some algorithms (JPS and clearance weight, bidirectional A* and turn weight). Those cards are marked "n/a": they stay in the assembly but are excluded from compilation, and the metrics and flow panels say so.

---

## Quick start

### Online

<https://Kind0419.github.io/Pathcraft/>

### Local

Requires Node.js >= 22.12 and pnpm.

```bash
git clone https://github.com/Kind0419/Pathcraft.git
cd Pathcraft
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173/`.

### Check, build, single file

```bash
pnpm typecheck
pnpm build
pnpm bundle
```

- `pnpm build`: typecheck + Vite build, output in `dist/`
- `pnpm bundle`: writes `release/Pathcraft.html`
- The single-file build opens offline by double-clicking

---

## Project layout

```text
src/
  App.tsx                 layout, state, URL, drag, map size, checks, export
  styles.css              one design system
  components/
    CanvasView.tsx        Canvas2D drawing, hit testing, markers, zoom, brush, continuous paths
    Card.tsx              assembly rows, sliders, switches, choice chips
    FlowPanel.tsx         grid / continuous execution trace, compile sites, drag reorder
    Icon.tsx              line icons
  lib/
    types.ts              shared types
    cards.ts              16 cards, symbols, compile sites, defaults
    maps.ts               presets, size limits, clearance
    planner.ts            grid search, strategy priority, cost, constraints, dispatch
    continuous.ts         RRT / RRT* / PRM / visibility, collision, smoothing
    feasibility.ts        feasible-range scan
    i18n.tsx              Chinese / English strings and context
    heap.ts               MinHeap
scripts/
  check.ts                planner smoke checks
  package.mjs             single-file packaging
```

---

## Contributing

Issues and pull requests are welcome. Before submitting, please run:

```bash
pnpm typecheck
pnpm build
```

If you touched the planner, also run:

```bash
pnpm exec tsx scripts/check.ts
```

---

## License

**MIT License** © 2026 Kind0419 · Pathcraft

You may use, modify, distribute and use this project commercially. Keep the copyright and permission notice in [LICENSE](LICENSE).

If Pathcraft helps your project, a credit to **Kind0419** and **Pathcraft** is appreciated.