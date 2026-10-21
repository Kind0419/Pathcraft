# Pathcraft

**An interactive, composable path-planning workbench.**  
Build path-planning algorithms from parameter cards and watch the search, execution trace, final path and metrics update live.

[中文](README.md) · [English](README.en.md)

[Live Demo](https://Kind0419.github.io/Pathcraft/) · [GitHub](https://github.com/Kind0419/Pathcraft) · [MIT License](LICENSE)

> Status: `0.4.0` · 2D grid · React + TypeScript + Canvas

[![Pathcraft interactive demo](https://Kind0419.github.io/Pathcraft/preview-en.png?v=1)](https://Kind0419.github.io/Pathcraft/)

> GitHub README is static Markdown, so the app cannot run inside it. Click the GIF above, or open <https://Kind0419.github.io/Pathcraft/> for the interactive version.

---

## What it is

Pathcraft is a 2D grid path-planning workbench that runs in the browser.

It decomposes planning into composable parameter modules:

- **Search**: A*, Dijkstra, greedy best-first, BFS, DFS, weighted A*
- **Cost**: clearance, turn, length, diagonal bias, goal tolerance
- **Constraints**: safety inflation, max turn, no U-turn, corner cut, expansion budget
- **Post-process**: line-of-sight straightening, Chaikin smoothing (passes), path thinning (tolerance)

Pick modules from the component library, tune values in the assembly table, and watch the search frontier, final path and previous path update in the canvas. The Flow tab maps the current replay frame to the actual execution branch and shows the queue, expanded states and each card's compile site.

---

## Features

- Three 2D maps: Notch, Gate, Clutter
- 2D map editing: draw / erase / brush 1·3·5 / clear / restore preset
- Click or drag start and goal; markers slide along safe boundaries and snap to the nearest legal cell
- Search replay: play, pause, timeline, 0.5x / 1x / 2x
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

![Pathcraft execution trace](https://Kind0419.github.io/Pathcraft/preview-flow-en.png?v=1)

---

## Algorithm scope

The current build covers the classic **graph-search backbone**, switchable from the Search strategy card:

| Strategy | Priority |
|---|---|
| A* | `g + h` |
| Weighted A* | `g + 1.5h` |
| Dijkstra | `g` |
| Greedy best-first | `h` |
| BFS | FIFO insertion order |
| DFS | LIFO order |

Not yet included: RRT / RRT* / PRM, D* Lite, JPS, IDA*, bidirectional search, Beam, ACO, genetic algorithms.

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

- `pnpm build`: type-check + Vite build, output in `dist/`
- `pnpm bundle`: writes `release/Pathcraft.html`
- The single-file build opens offline with a double-click

---

## Project structure

```text
src/
  App.tsx                 layout, state, URL, dragging, parameter scan, export
  styles.css              single design system
  components/
    CanvasView.tsx        Canvas2D drawing, hit testing, start/goal, zoom, brush
    Card.tsx              assembly row, slider, switch, choice chips
    FlowPanel.tsx         execution trace, compile sites, flow dragging
    Icon.tsx              line icons
  lib/
    types.ts              shared types
    cards.ts              16 cards, parameter symbols, compile sites, defaults
    maps.ts               preset maps, clearance
    planner.ts            graph search, priorities, costs, constraints
    feasibility.ts        parameter feasibility scan
    i18n.tsx              Chinese/English strings and language context
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

If you changed the planner:

```bash
pnpm exec tsx scripts/check.ts
```

---

## License

**MIT License** © 2026 Kind0419 · Pathcraft

You may use, modify, distribute and use this project commercially. Keep the copyright and permission notice in [LICENSE](LICENSE).

If Pathcraft helps your project, a credit to **Kind0419** and **Pathcraft** is appreciated.