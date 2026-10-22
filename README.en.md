# Pathcraft

**An interactive, composable path-planning workbench.**  
Build path-planning algorithms from parameter cards and watch the search, execution trace, final path and metrics update live.

[中文](README.md) · [English](README.en.md)

[Live Demo](https://Kind0419.github.io/Pathcraft/) · [GitHub](https://github.com/Kind0419/Pathcraft) · [MIT License](LICENSE)

> Status: `0.5.1` · 2D grid + continuous · React + TypeScript + Canvas

[![Pathcraft interactive demo](https://Kind0419.github.io/Pathcraft/preview-en.png?v=2)](https://Kind0419.github.io/Pathcraft/)

> GitHub README is static Markdown, so the app cannot run inside it. Click the screenshot above, or open <https://Kind0419.github.io/Pathcraft/> for the interactive version.

---

## What it is

Pathcraft is a 2D path-planning workbench that runs in the browser. It supports both **grid graph search** and **continuous-space sampling planners**.

It decomposes planning into composable parameter modules:

- **Search**: A*, Dijkstra, greedy best-first, BFS, DFS, weighted A*; RRT, RRT*, PRM, visibility graph
- **Cost**: clearance, turn, length, diagonal bias, goal tolerance
- **Constraints**: safety inflation, max turn, no U-turn, corner cut, expansion budget
- **Post-process**: line-of-sight straightening, Chaikin smoothing (passes), path thinning (tolerance)

Pick modules from the component library, tune values in the assembly table, and watch the search frontier, final path and previous path update in the canvas. The Flow tab maps the current replay frame to the actual execution branch and shows the queue, expanded states and each card's compile site. Selecting RRT / RRT* / PRM / Visibility graph switches the canvas to a continuous 2D space and outputs a smooth polyline.

---

## Features

- Three 2D maps: Notch, Gate, Clutter
- Map-size editor: 24–72 columns × 18–56 rows, up to 4032 cells; keeps existing walls and safely relocates start/goal
- 2D map editing: draw / erase / brush 1·3·5 / clear / restore preset
- Grid mode: A* / Dijkstra / greedy / BFS / DFS / weighted A*
- Continuous mode: RRT / RRT* / PRM / visibility graph with smooth continuous paths
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

### Execution trace

The Flow tab is not a static diagram. It highlights the branch taken at the current replay frame and shows the current node, g / h / f, open set and expansion state. The assembly table below can be dragged to reorder; hovering a row highlights the affected area on the canvas.

![Pathcraft execution trace](https://Kind0419.github.io/Pathcraft/preview-flow-en.png?v=2)

### Continuous space

RRT / RRT* / PRM / Visibility graph turn search points into continuous samples and smooth the final path after collision checking. Map size, safety inflation and start/goal still apply.

![Pathcraft continuous planning](https://Kind0419.github.io/Pathcraft/preview-continuous-en.png?v=2)

---

## Algorithm scope

### Grid graph search

| Strategy | Priority |
|---|---|
| A* | `g + h` |
| Weighted A* | `g + 1.5h` |
| Dijkstra | `g` |
| Greedy best-first | `h` |
| BFS | FIFO insertion order |
| DFS | LIFO order |

### Continuous 2D space

| Strategy | Method |
|---|---|
| RRT | random sample + nearest neighbour + steer + collision check |
| RRT* | RRT + neighbourhood rewiring for shorter paths |
| PRM | sampled roadmap + k-nearest connections + Dijkstra |
| Visibility graph | free-space roadmap + 8-neighbour links + visible shortcuts + Dijkstra |

Continuous planners apply one line-of-sight shortcut pass, round corners where clearance allows, then honour the line-of-sight / Chaikin / thinning cards. Safety inflation is used for sampled points, edge collision and corner rounding.

Not yet included: D* Lite, JPS, IDA*, bidirectional search, Beam, ACO, genetic algorithms.

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