import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Card } from './components/Card'
import { CanvasView } from './components/CanvasView'
import { Scene3D } from './components/Scene3D'
import { FlowPanel } from './components/FlowPanel'
import { Icon } from './components/Icon'
import {
  CARD_BY_ID,
  CARD_DEFS,
  CARD_GROUPS,
  CARD_STAGES,
  cardValueLabel,
  createDefaultCards,
  createDefaultRecipeOrder,
  type CardDef,
} from './lib/cards'
import { scanFeasibility } from './lib/feasibility'
import {
  LangContext,
  fmtNum,
  localizeAlgorithm,
  plural,
  tr,
  useLang,
  type Lang,
} from './lib/i18n'
import { getMap, mapFromCells, MAPS, MAP_LIMITS, clampMapSize, findFreeCell, resizeCells } from './lib/maps'
import {
  WORLD_GROUPS,
  isWorldId,
  resolveWorld,
  snapEndpoint,
  worldEndpoints,
  worldMeta,
  type WorldId,
} from './lib/worlds'
import { usePlan } from './hooks/usePlan'
import { useWorldPlan } from './hooks/useWorldPlan'
import { readSetting, writeSetting } from './lib/storage'
import {
  FAMILIES,
  SOLVER_BY_VALUE,
  cardApplies,
  optionalCards,
  solverFor,
  supportsDim,
  type SolverSpec,
} from './lib/solvers/registry'
import type { Vec3 } from './lib/core/space'
import type {
  CardId,
  CardsState,
  GridMap,
  MapId,
  PlanResult,
  Point,
} from './lib/types'

type RightTab = 'recipe' | 'metrics' | 'card' | 'flow' | 'run'

interface MetricSnapshot {
  lengthM: number
  expanded: number
  clearanceM: number
  timeMs: number
}

const DEFAULT_MAP_ID: MapId = 'clutter'
const VERSION = '0.5.1'

function clampCardValue(id: CardId, value: number): number {
  const def = CARD_BY_ID[id]
  if (def.kind === 'choice') {
    const last = Math.max(0, (def.options?.length ?? 1) - 1)
    if (!Number.isFinite(value)) return def.defaultValue
    return Math.min(last, Math.max(0, Math.round(value)))
  }
  const min = def.min ?? 0
  const max = def.max ?? 1
  if (!Number.isFinite(value)) return def.defaultValue
  return Math.min(max, Math.max(min, value))
}

function encodeCells(cells: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < cells.length; offset += chunk) {
    binary += String.fromCharCode(
      ...Array.from(cells.subarray(offset, offset + chunk)),
    )
  }
  return btoa(binary)
}

function decodeCells(value: string, length: number): Uint8Array | null {
  try {
    const binary = atob(value)
    if (binary.length !== length) return null
    const cells = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) cells[i] = binary.charCodeAt(i)
    return cells
  } catch {
    return null
  }
}

function readRecipeFromUrl(): {
  worldId: WorldId
  cards: CardsState
  order: CardId[]
  start: Point
  goal: Point
  cells: Uint8Array | null
  size: { width: number; height: number } | null
  start3: Vec3 | null
  goal3: Vec3 | null
} | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash
  if (!hash.startsWith('#r=')) return null
  try {
    const payload = JSON.parse(decodeURIComponent(hash.slice(3))) as {
      m?: string
      c?: Record<string, [number, number]>
      o?: string[]
      s?: number[]
      g?: number[]
      s3?: number[]
      g3?: number[]
      x?: string
      w?: number
      h?: number
    }
    const parsedId = typeof payload.m === 'string' && isWorldId(payload.m) ? payload.m : null
    if (!parsedId) return null
    const parsedWorld = resolveWorld(parsedId)
    const baseMap = parsedWorld.kind === 'grid2d' ? parsedWorld.map : getMap(DEFAULT_MAP_ID)
    const cards = createDefaultCards()
    for (const def of CARD_DEFS) {
      const entry = payload.c?.[def.id]
      if (!Array.isArray(entry) || entry.length < 2) continue
      cards[def.id] = {
        enabled: Boolean(entry[0]),
        value: clampCardValue(def.id, Number(entry[1])),
      }
    }
    const order = Array.isArray(payload.o)
      ? Array.from(
          new Set(
            payload.o.filter((id): id is CardId => Boolean(CARD_BY_ID[id as CardId])),
          ),
        )
      : createDefaultRecipeOrder()

    const requested =
      typeof payload.w === 'number' && typeof payload.h === 'number'
        ? clampMapSize(payload.w, payload.h)
        : null
    const decoded =
      typeof payload.x === 'string'
        ? decodeCells(
            payload.x,
            (requested?.width ?? baseMap.width) *
              (requested?.height ?? baseMap.height),
          )
        : null
    const size = requested && decoded ? requested : null
    const width = size?.width ?? baseMap.width
    const height = size?.height ?? baseMap.height
    const gridCells = decoded ?? baseMap.cells

    const readPoint = (entry: number[] | undefined, fallback: Point): Point => {
      const fallbackPoint =
        fallback.x > 0 && fallback.y > 0 && fallback.x < width - 1 && fallback.y < height - 1
          ? fallback
          : findFreeCell(gridCells, width, height, { x: 2, y: 2 })
      if (!Array.isArray(entry) || entry.length < 2) return { ...fallbackPoint }
      const x = Math.round(Number(entry[0]))
      const y = Math.round(Number(entry[1]))
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height ||
        gridCells[y * width + x] === 1
      ) {
        return { ...fallbackPoint }
      }
      return { x, y }
    }
    if (parsedWorld.kind !== 'grid2d') {
      const ends = worldEndpoints(parsedWorld)
      const read3 = (entry: number[] | undefined, fallback: Vec3): Vec3 => {
        if (!Array.isArray(entry) || entry.length < 3) return fallback
        const point = { x: Number(entry[0]), y: Number(entry[1]), z: Number(entry[2]) }
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
          return fallback
        }
        return snapEndpoint(parsedWorld, point)
      }
      return {
        worldId: parsedId,
        cards,
        order,
        start: { ...baseMap.start },
        goal: { ...baseMap.goal },
        cells: null,
        size: null,
        start3: read3(payload.s3, ends.start),
        goal3: read3(payload.g3, ends.goal),
      }
    }

    let start = readPoint(payload.s, baseMap.start)
    let goal = readPoint(payload.g, baseMap.goal)
    if (start.x === goal.x && start.y === goal.y) {
      start = findFreeCell(gridCells, width, height, { x: 2, y: 2 })
      goal = findFreeCell(gridCells, width, height, {
        x: width - 3,
        y: height - 3,
      })
    }
    return {
      worldId: parsedId,
      cards,
      order,
      start,
      goal,
      cells: decoded,
      size,
      start3: null,
      goal3: null,
    }
  } catch {
    return null
  }
}

const INITIAL_RECIPE = readRecipeFromUrl()

function serializeRecipe(
  worldId: WorldId,
  cards: CardsState,
  order: CardId[],
  start: Point,
  goal: Point,
  start3: Vec3 | null,
  goal3: Vec3 | null,
  cells: Uint8Array | null,
  size: { width: number; height: number } | null,
): string {
  const compact = {
    m: worldId,
    o: order,
    s: [start.x, start.y],
    g: [goal.x, goal.y],
    // 3D worlds carry their endpoints in world units; the 2D pair above stays
    // as the fallback so a downgraded link still opens something sensible.
    s3: start3 ? [start3.x, start3.y, start3.z] : undefined,
    g3: goal3 ? [goal3.x, goal3.y, goal3.z] : undefined,
    x: cells ? encodeCells(cells) : undefined,
    w: cells ? size?.width : undefined,
    h: cells ? size?.height : undefined,
    c: Object.fromEntries(
      CARD_DEFS.map((def) => [
        def.id,
        [cards[def.id].enabled ? 1 : 0, Number(cards[def.id].value.toFixed(2))],
      ]),
    ),
  }
  return encodeURIComponent(JSON.stringify(compact))
}

function metricSnapshot(result: PlanResult, map: GridMap): MetricSnapshot {
  return {
    lengthM: result.pathLength * map.cellSize,
    expanded: result.expanded,
    clearanceM: result.minClearance * map.cellSize,
    timeMs: result.solveTime,
  }
}

function formatNumber(value: number, lang: Lang = 'zh'): string {
  return fmtNum(lang, value)
}

function compileFormula(
  cards: CardsState,
  order: CardId[],
  lang: Lang = 'zh',
): string {
  const modeIndex = cards.strategy.enabled ? Math.round(cards.strategy.value) : 0
  const modeLabel = tr(
    lang,
    CARD_BY_ID.strategy.options?.[modeIndex] ?? 'A*',
  )
  // Ask the registry instead of using the option index: the index order is a
  // share-link detail, so ">= 6 means sampling" stopped being true the moment
  // JPS / IDA* / D* Lite / ACO were appended to the same list.
  const spec = solverFor(cards)
  if (spec.family === 'sampling') {
    return lang === 'en'
      ? `${modeLabel}: sample → steer → collision check → tree/roadmap → path`
      : `${modeLabel}：采样 → 步进 → 碰撞检查 → 树 / 路线图 → 路径`
  }
  if (spec.family === 'meta') {
    return lang === 'en'
      ? `${modeLabel}: seed → iterate (evaluate · select · perturb) → keep best`
      : `${modeLabel}：初始解 → 迭代（评估 · 选择 · 扰动）→ 保留最优`
  }
  if (spec.costModel === 'uniform') {
    return lang === 'en'
      ? `${modeLabel}: uniform step cost, so clearance / turn weights are not in the objective`
      : `${modeLabel}：等步长代价，间隙权重与转角权重不进入目标函数`
  }
  const ignoreHeuristic = spec.costModel === 'distance'
  const lengthWeight = cards.lengthWeight.enabled
    ? `${cards.lengthWeight.value.toFixed(2)}·g`
    : 'g'
  const terms = [lengthWeight]
  const constraints: string[] = []
  const bridges: string[] = []

  for (const id of order) {
    const state = cards[id]
    if (!state.enabled) continue
    if (id === 'strategy') constraints.push(`mode = ${modeLabel}`)
    if (id === 'heuristic' && !ignoreHeuristic) {
      terms.push(`${state.value.toFixed(2)}·h`)
    }
    if (id === 'clearance' && spec.costModel === 'full') {
      terms.push(`${state.value.toFixed(2)}·c`)
    }
    if (id === 'turn' && spec.costModel === 'full' && spec.directional) {
      terms.push(`${state.value.toFixed(2)}·t`)
    }
    if (id === 'diagonalBias' && spec.costModel === 'full') {
      terms.push(`${state.value.toFixed(2)}·o`)
    }
    if (id === 'collision') {
      constraints.push(`s.t. d ≥ ${state.value.toFixed(2)}`)
    }
    if (id === 'goalTolerance') {
      constraints.push(`s.t. ||n-g|| ≤ ${state.value.toFixed(2)}`)
    }
    if (id === 'cornerCut') {
      constraints.push(
        lang === 'en' ? 'geom · corner cut' : 'geom · 允许切角',
      )
    }
    if (id === 'budget') {
      constraints.push(`s.t. expanded ≤ ${Math.round(state.value)}`)
    }
    if (id === 'noUTurn') constraints.push('s.t. Δθ ≠ 180°')
    if (id === 'maxTurn') {
      constraints.push(`s.t. Δθ ≤ ${state.value.toFixed(0)}°`)
    }
    if (id === 'smooth') {
      bridges.push(lang === 'en' ? 'straighten' : '拉直')
    }
    if (id === 'round') {
      bridges.push(lang === 'en' ? 'Chaikin' : '圆角')
    }
    if (id === 'simplify') {
      bridges.push(lang === 'en' ? 'simplify' : '抽稀')
    }
  }

  if (bridges.length > 0) constraints.push(`bridge · ${bridges.join(' + ')}`)
  return `f = ${terms.join(' + ')}${
    constraints.length ? `
${constraints.join('   ·   ')}` : ''
  }`
}

function diagnoseInfeasible(
  cards: CardsState,
  result: PlanResult,
  lang: Lang = 'zh',
): { title: string; hint: string; card: CardId | null } {
  if (result.reason === 'unsupported') {
    return {
      title: tr(lang, '该算法没有三维实现'),
      hint:
        lang === 'en'
          ? result.note ??
            'This algorithm only exists for 2D. Pick A*, Dijkstra, greedy, BFS, DFS, weighted A* or RRT* instead.'
          : result.note ?? '这个算法只有 2D 实现。请改选 A*、Dijkstra、贪心、BFS、DFS、加权 A* 或 RRT*。',
      card: null,
    }
  }
  if (result.continuous) {
    return {
      title: tr(lang, '采样未连通'),
      hint:
        lang === 'en'
          ? 'The sampler did not connect start and goal. Raise "Expansion budget", reduce "Safety inflation", or switch to PRM / Visibility graph.'
          : '采样没有连通起点和终点。提高「扩展预算」、减小「安全膨胀」，或换 PRM / 可见性图。',
      card: 'budget',
    }
  }
  if (
    cards.budget.enabled &&
    result.expanded >= Math.floor(cards.budget.value)
  ) {
    return {
      title: tr(lang, '扩展预算耗尽'),
      hint:
        lang === 'en'
          ? `Expanded ${formatNumber(result.expanded, lang)} states and hit the budget. Raise "Expansion budget" or use a more direct strategy.`
          : `本轮扩展了 ${formatNumber(result.expanded, lang)} 个节点，达到预算上限。提高「扩展预算」，或换更直接的策略。`,
      card: 'budget',
    }
  }
  if (cards.maxTurn.enabled) {
    return {
      title: tr(lang, '最大转角约束过严'),
      hint:
        lang === 'en'
          ? 'The path needs a larger turn. Relax "Max turn" to 90° or 135°, or disable that constraint.'
          : '当前路径需要更大的转向角。把「最大转角」放宽到 90° 或 135°，或暂时停用该约束。',
      card: 'maxTurn',
    }
  }
  if (cards.noUTurn.enabled) {
    return {
      title: tr(lang, '禁止掉头切断了通道'),
      hint:
        lang === 'en'
          ? 'Disable "No U-turn" and retry. In a narrow corridor, forbidding 180° reversals can cut the only passage.'
          : '关闭「禁止掉头」再试；在窄走廊里禁止 180° 反向可能会把唯一通路剪掉。',
      card: 'noUTurn',
    }
  }
  if (cards.collision.enabled) {
    return {
      title: tr(lang, '安全膨胀半径过大'),
      hint:
        lang === 'en'
          ? 'Inflated obstacles closed the corridor. Reduce "Safety inflation", or disable it to inspect the raw path.'
          : '障碍膨胀后通道被堵死。调小「安全膨胀」半径，或关闭硬约束观察原始路径。',
      card: 'collision',
    }
  }
  return {
    title: tr(lang, '起点或终点被围住'),
    hint:
      lang === 'en'
        ? 'Drag S / G to a more open area, or use Edit to clear obstacles around the endpoint.'
        : '拖动 S / G 到更开阔的位置，或用「编辑」清掉端点附近的障碍。',
    card: null,
  }
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

function csvEscape(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function Delta({
  current,
  previous,
  digits = 2,
  unit = '',
  higherIsBetter = false,
}: {
  current: number
  previous: number | null
  digits?: number
  unit?: string
  higherIsBetter?: boolean
}) {
  if (previous === null) return <span className="delta is-flat">—</span>
  const difference = current - previous
  if (Math.abs(difference) < 10 ** -digits / 2) {
    return <span className="delta is-flat">±0</span>
  }
  const good = higherIsBetter ? difference > 0 : difference < 0
  return (
    <span className={`delta ${good ? 'is-good' : 'is-bad'}`}>
      {difference > 0 ? '+' : ''}
      {difference.toFixed(digits)}
      {unit}
    </span>
  )
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {action}
    </div>
  )
}

function MetricsPanel({
  map,
  result,
  previous,
  cards,
  onSelectCard,
  onQuickToggle,
}: {
  map: GridMap
  result: PlanResult
  previous: MetricSnapshot | null
  cards: CardsState
  onSelectCard: (id: CardId) => void
  onQuickToggle: (id: CardId) => void
}) {
  const lang = useLang()
  // A 3D/field result already reports metres; a grid result reports cells.
  const scale = result.path3 ? 1 : map.cellSize
  const lengthM = result.pathLength * scale
  const clearanceM = result.minClearance * scale
  const total = result.totalCost
  const costItems: Array<{ id: string; label: string; value: number; color: string; card?: CardId }> = [
    { id: 'length', label: tr(lang, '长度'), value: result.cost.length, color: '#1f4e5f' },
    {
      id: 'clearance',
      label: tr(lang, '间隙'),
      value: result.cost.clearance,
      color: '#8a6a2f',
      card: 'clearance',
    },
    {
      id: 'turn',
      label: tr(lang, '转角'),
      value: result.cost.turn,
      color: '#8f5540',
      card: 'turn',
    },
    ...(cards.diagonalBias.enabled
      ? [
          {
            id: 'bias',
            label: tr(lang, '斜向'),
            value: result.cost.bias,
            color: '#5c6560',
            card: 'diagonalBias' as CardId,
          },
        ]
      : []),
  ]

  let donutCursor = 0
  const donutStops = costItems
    .filter((item) => item.value > 0)
    .map((item) => {
      const start = donutCursor
      donutCursor += total > 0 ? (item.value / total) * 100 : 0
      return `${item.color} ${start.toFixed(2)}% ${donutCursor.toFixed(2)}%`
    })
    .join(', ')
  const donutBackground =
    total > 0 && donutStops ? `conic-gradient(${donutStops})` : '#eeeae3'

  return (
    <div className="panel-scroll panel-content">
      <div className="run-heading">
        <div>
          <span className={`status-dot ${result.status === 'success' ? '' : 'is-bad'}`} />
          <strong>{result.status === 'success' ? tr(lang, '已收敛') : tr(lang, '无可行路径')}</strong>
        </div>
        <span className="run-time">{result.solveTime.toFixed(1)} ms</span>
      </div>

      <div className="hero-metric">
        <span className="metric-label">{tr(lang, '路径长度')}</span>
        <div className="hero-value">
          <span
            key={`len-${result.status}-${lengthM.toFixed(2)}`}
            className="value-anim"
          >
            {result.status === 'success' ? lengthM.toFixed(2) : '—'}
          </span>
          {result.status === 'success' ? <em>m</em> : null}
          {result.status === 'success' ? (
            <Delta current={lengthM} previous={previous?.lengthM ?? null} unit=" m" />
          ) : null}
        </div>
        <p className="hero-context">
          {localizeAlgorithm(lang, result.algorithmLabel)} · {result.continuous ? tr(lang, '连续空间') : cards.diagonal.enabled ? tr(lang, '8 邻域') : tr(lang, '4 邻域')} ·{' '}
          {plural(lang, result.waypoints, '个路径点', 'waypoint')}
        </p>
        {result.note ? <p className="metric-note">{result.note}</p> : null}
      </div>

      <div className="stat-row">
        <div className="stat">
          <span className="stat-label">{tr(lang, '扩展节点')}</span>
          <strong key={`exp-${result.expanded}`} className="value-anim">
            {formatNumber(result.expanded, lang)}
          </strong>
          <Delta
            current={result.expanded}
            previous={previous?.expanded ?? null}
            digits={0}
          />
        </div>
        <div className="stat">
          <span className="stat-label">{tr(lang, '最小间隙')}</span>
          <strong
            key={`clr-${result.status}-${clearanceM.toFixed(2)}`}
            className="value-anim"
          >
            {result.status === 'success' ? clearanceM.toFixed(2) : '—'}
            {result.status === 'success' ? <em>m</em> : null}
          </strong>
          <Delta
            current={clearanceM}
            previous={previous?.clearanceM ?? null}
            unit=" m"
            higherIsBetter
          />
        </div>
        <div className="stat">
          <span className="stat-label">{tr(lang, '求解时间')}</span>
          <strong key={`time-${result.solveTime.toFixed(1)}`} className="value-anim">
            {result.solveTime.toFixed(1)}
            <em>ms</em>
          </strong>
          <Delta
            current={result.solveTime}
            previous={previous?.timeMs ?? null}
            digits={1}
            unit=" ms"
          />
        </div>
      </div>

      <SectionLabel action={<span className="section-note">{tr(lang, '对比上次运行')}</span>}>
        {tr(lang, '代价构成')}
      </SectionLabel>
      <div className="cost-card">
        <div
          className="cost-donut"
          style={{ background: donutBackground }}
          aria-label={lang === 'en' ? `Total cost ${total.toFixed(1)}` : `总代价 ${total.toFixed(1)}`}
        >
          <div className="cost-donut-center">
            <strong>{total.toFixed(1)}</strong>
            <span>cost</span>
          </div>
        </div>
        <div className="cost-main">
          <div className="cost-total">
            <span>{tr(lang, '总代价')}</span>
            <strong>{total.toFixed(1)}</strong>
          </div>
          <div className="cost-bar" aria-label={tr(lang, '代价构成')}>
            {total > 0
              ? costItems.map((item) =>
                  item.value > 0 ? (
                    <span
                      key={item.id}
                      style={{
                        width: `${(item.value / total) * 100}%`,
                        background: item.color,
                      }}
                    />
                  ) : null,
                )
              : <span className="cost-empty" />}
          </div>
          <div className="cost-list">
            {costItems.map((item) => {
              const percent = total > 0 ? (item.value / total) * 100 : 0
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`cost-item ${item.card ? 'is-clickable' : ''}`}
                  onClick={() => item.card && onSelectCard(item.card)}
                  disabled={!item.card}
                >
                  <span className="cost-dot" style={{ background: item.color }} />
                  <span>{item.label}</span>
                  <span className="cost-percent">{percent.toFixed(0)}%</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>


      <div className="quick-section">
        <SectionLabel>{tr(lang, '快速对照')}</SectionLabel>
        <div className="quick-actions">
          <button
            type="button"
            className="quick-action"
            onClick={() => onQuickToggle('heuristic')}
          >
            <span className="quick-icon">
              <Icon name="compass" size={14} />
            </span>
            <span className="quick-copy">
              <strong>
                {cards.heuristic.enabled ? tr(lang, '关闭启发式权重') : tr(lang, '恢复启发式权重')}
              </strong>
              <em>
                {cards.heuristic.enabled
                  ? tr(lang, '对比均匀扩散与目标导向扩散')
                  : tr(lang, '恢复 A* 的目标导向排序')}
              </em>
            </span>
            <Icon name="stepForward" size={12} className="quick-arrow" />
          </button>
          <button
            type="button"
            className="quick-action"
            onClick={() => onQuickToggle('smooth')}
          >
            <span className="quick-icon">
              <Icon name="smooth" size={14} />
            </span>
            <span className="quick-copy">
              <strong>
                {cards.smooth.enabled ? tr(lang, '关闭可见性拉直') : tr(lang, '启用可见性拉直')}
              </strong>
              <em>
                {cards.smooth.enabled
                  ? tr(lang, '回到搜索产生的原始折线')
                  : tr(lang, '对比拐点数量与路径长度')}
              </em>
            </span>
            <Icon name="stepForward" size={12} className="quick-arrow" />
          </button>
        </div>
      </div>

      <p className="metric-footnote">{tr(lang, '指标按本轮最终路径计算，不做视觉估算。')}</p>
    </div>
  )
}

function CardInspector({
  id,
  state,
  map,
  cards,
  order,
  continuous,
  solver,
  onToggle,
  onValue,
  onAdjustStart,
  onAdjustEnd,
  onAddCard,
}: {
  id: CardId
  state: { enabled: boolean; value: number }
  map: GridMap
  cards: CardsState
  order: CardId[]
  continuous: boolean
  solver: SolverSpec
  onToggle: () => void
  onValue: (value: number) => void
  onAdjustStart: () => void
  onAdjustEnd: () => void
  onAddCard: (id: CardId) => void
}) {
  const lang = useLang()
  const def = CARD_BY_ID[id]
  const group = CARD_GROUPS.find((item) => item.id === def.group)
  const stage = CARD_STAGES.find((item) => item.id === def.stage)
  const hasSlider = def.kind !== 'toggle'
  const min = def.min ?? 0
  const max = def.max ?? 1
  const fill = max > min ? ((state.value - min) / (max - min)) * 100 : 0
  const [scanState, setScanState] = useState<{
    id: CardId
    scan: ReturnType<typeof scanFeasibility>
  } | null>(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    if (!hasSlider || (continuous && id === 'strategy')) {
      setScanning(false)
      return
    }
    setScanning(true)
    const timer = window.setTimeout(() => {
      setScanState({
        id,
        scan: scanFeasibility(map, cards, order, id, continuous ? 6 : 25),
      })
      setScanning(false)
    }, 220)
    return () => {
      window.clearTimeout(timer)
      setScanning(false)
    }
  }, [id, map, cards, order, hasSlider, continuous])

  const applies = cardApplies(id, solver)
  const scan = scanState?.id === id ? scanState.scan : null
  const scannable = solver.scan && applies
  const missingOptional = optionalCards(solver).filter((card) => !order.includes(card))
  const formatBound = (value: number) => {
    if (def.kind === 'angle' || def.kind === 'budget' || def.kind === 'passes') {
      return value.toFixed(0)
    }
    return value.toFixed(2)
  }
  const feasibleSpans =
    scan?.spans.filter((span) => span.feasible && span.to - span.from > 1e-9) ??
    []
  const feasiblePoints = scan?.points.filter((point) => point.feasible) ?? []
  const feasibleLabel = !scan
    ? tr(lang, '等待扫描')
    : def.kind === 'choice'
      ? `${feasiblePoints.length} / ${scan.points.length} ${tr(lang, '个选项可行')}`
      : feasibleSpans.length > 0
        ? feasibleSpans
            .map(
              (span) =>
                `${formatBound(span.from)}–${formatBound(span.to)}`,
            )
            .join(' · ')
        : feasiblePoints.length > 0
          ? `${tr(lang, '单点可行')} · ${formatBound(feasiblePoints[0].value)}`
          : tr(lang, '无可行值')
  const currentPct = max > min ? ((state.value - min) / (max - min)) * 100 : 0

  return (
    <div className="panel-scroll panel-content inspector">
      <header className="detail-head">
        <div className="detail-kicker">
          <span>{tr(lang, group?.label ?? '')}</span>
          <span>{tr(lang, stage?.label ?? '')}</span>
        </div>
        <div className="detail-title-row">
          <h2>
            {tr(lang, def.title)}
            <span className="detail-param">{def.param}</span>
          </h2>
          <button
            className={`switch ${state.enabled ? 'is-on' : ''}`}
            type="button"
            role="switch"
            aria-checked={state.enabled}
            aria-label={lang === 'en' ? `${state.enabled ? 'Disable' : 'Enable'} ${tr(lang, def.title)}` : `${state.enabled ? '停用' : '启用'}${def.title}`}
            onClick={onToggle}
          >
            <span className="switch-thumb" />
          </button>
        </div>
        <p className="detail-lede">{tr(lang, def.subtitle)}</p>
      </header>

      {!applies ? (
        <div className="na-banner">
          <strong>{tr(lang, '对当前算法不适用')}</strong>
          <p>
            {tr(lang, '当前算法')} {tr(lang, solver.label)}：{tr(lang, '这个参数不会改变它的搜索结果，卡片会保留在装配表里但不参与编译。')}
          </p>
        </div>
      ) : null}

      <p className="detail-text">{tr(lang, def.detail)}</p>

      <div className="detail-spec">
        <div>
          <span>{tr(lang, '编译位点')}</span>
          <strong>{tr(lang, def.compiles)}</strong>
        </div>
        <div>
          <span>{tr(lang, '画布映射')}</span>
          <strong>{tr(lang, def.visual)}</strong>
        </div>
      </div>

      <div className="formula-block">
        <span>{tr(lang, '公式')}</span>
        <pre>{def.formula}</pre>
      </div>

      <section className="detail-control">
        <div className="detail-control-head">
          <span>{tr(lang, '参数')} · {def.param}</span>
          <strong>{cardValueLabel(def, state.value, lang)}</strong>
        </div>
        {def.kind === 'choice' ? (
          <div className="inspector-choice">
            {def.id === 'strategy' ? (
              FAMILIES.map((family) => (
                <div className="family-block" key={family.id}>
                  <span className="family-head">
                    {lang === 'en' ? family.labelEn : family.label}
                    <em>{tr(lang, lang === 'en' ? family.hintEn : family.hint)}</em>
                  </span>
                  <div className="choice-row">
                    {def.options?.map((option, index) =>
                      SOLVER_BY_VALUE[index]?.family === family.id ? (
                        <button
                          key={option}
                          type="button"
                          className={`choice-chip ${
                            Math.round(state.value) === index ? 'is-active' : ''
                          }`}
                          disabled={!state.enabled}
                          aria-pressed={Math.round(state.value) === index}
                          onClick={() => onValue(index)}
                        >
                          {tr(lang, option)}
                        </button>
                      ) : null,
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="choice-row">
                {def.options?.map((option, index) => (
                  <button
                    key={option}
                    type="button"
                    className={`choice-chip ${
                      Math.round(state.value) === index ? 'is-active' : ''
                    }`}
                    disabled={!state.enabled}
                    aria-pressed={Math.round(state.value) === index}
                    onClick={() => onValue(index)}
                  >
                    {tr(lang, option)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : hasSlider ? (
          <>
            <input
              className="range range-inspector"
              type="range"
              min={def.min ?? 0}
              max={def.max ?? 1}
              step={def.step ?? 0.05}
              value={state.value}
              disabled={!state.enabled}
              aria-label={lang === 'en' ? `${tr(lang, def.title)} parameter ${def.param}` : `${def.title}参数 ${def.param}`}
              style={
                {
                  '--fill': `${fill}%`,
                } as CSSProperties
              }
              onChange={(event) => onValue(Number(event.target.value))}
              onPointerDown={onAdjustStart}
              onPointerUp={onAdjustEnd}
              onPointerCancel={onAdjustEnd}
              onBlur={onAdjustEnd}
            />
            <div className="range-scale">
              <span>{formatBound(min)}</span>
              <span>{formatBound(max)}</span>
            </div>
            {scannable ? (
            <div className="feas-block">
              <div className="feas-head">
                <span>{tr(lang, '可行区间')}</span>
                <em>{scanning ? tr(lang, '扫描中…') : feasibleLabel}</em>
              </div>
              <div className="feas-band" aria-hidden="true">
                {scan
                  ? scan.spans.map((span, index) => {
                      const left =
                        max > min ? ((span.from - min) / (max - min)) * 100 : 0
                      const width =
                        max > min ? ((span.to - span.from) / (max - min)) * 100 : 0
                      if (def.kind === 'choice') {
                        return (
                          <span
                            key={`${span.from}-${index}`}
                            className={`feas-dot ${span.feasible ? 'is-ok' : 'is-no'}`}
                            style={{ left: `${left}%` }}
                          />
                        )
                      }
                      return (
                        <span
                          key={`${span.from}-${index}`}
                          className={`feas-seg ${span.feasible ? 'is-ok' : 'is-no'}`}
                          style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%` }}
                        />
                      )
                    })
                  : null}
                <i style={{ left: `${currentPct}%` }} />
              </div>
              <p className={`feas-status ${scan?.currentFeasible ? 'is-ok' : ''}`}>
                {scan?.currentFeasible
                  ? tr(lang, '当前值可行')
                  : scan
                    ? tr(lang, '当前值不可行 · 可行域可能不连续，可继续拖动到另一段')
                    : tr(lang, '扫描不会锁死滑杆，只用于提示')}
              </p>
            </div>
            ) : (
              <p className="feas-skip">
                {applies
                  ? tr(lang, '这个算法是随机或重搜索，扫描约三十次代价太高，因此跳过可行域扫描。')
                  : tr(lang, '当前算法不使用这个参数，不扫描可行域。')}
              </p>
            )}
          </>
        ) : (
          <div className="toggle-note">
            <span>{state.enabled ? tr(lang, '正在参与编译') : tr(lang, '已停用，不影响结果')}</span>
            <strong>{state.enabled ? tr(lang, '开') : tr(lang, '关')}</strong>
          </div>
        )}
      </section>

      {missingOptional.length > 0 ? (
        <div className="optional-cards">
          <span>{tr(lang, '该算法还能调')}</span>
          {missingOptional.map((card) => (
            <button key={card} type="button" onClick={() => onAddCard(card)}>
              + {tr(lang, CARD_BY_ID[card].title)}
              <em>{CARD_BY_ID[card].param}</em>
            </button>
          ))}
        </div>
      ) : null}

      <p className="param-hint">
        {tr(lang, '参数不会被无解区间锁死。可行域可能分段出现，扫描结果只作为参考。')}
      </p>
      <p className="inspector-hint">
        {tr(lang, '悬停装配表或组件库中的卡片，画布会高亮该参数影响的区域。')}
      </p>
    </div>
  )
}

function RunPanel({
  map,
  cards,
  result,
  formula,
  onReplay,
  onExportJson,
  onExportCsv,
  onReset,
}: {
  map: GridMap
  cards: CardsState
  result: PlanResult
  formula: string
  onReplay: () => void
  onExportJson: () => void
  onExportCsv: () => void
  onReset: () => void
}) {
  const lang = useLang()
  return (
    <div className="panel-scroll panel-content">
      <SectionLabel>{tr(lang, '本轮结果')}</SectionLabel>
      <div className="definition-list">
        <div>
          <span>{tr(lang, '算法')}</span>
          <strong>{localizeAlgorithm(lang, result.algorithmLabel)}</strong>
        </div>
        <div>
          <span>{tr(lang, '路径点')}</span>
          <strong>{result.waypoints}</strong>
        </div>
        <div>
          <span>{tr(lang, '扩展 / 覆盖')}</span>
          <strong>
            {formatNumber(result.expanded, lang)} / {formatNumber(result.expandedCells, lang)}
          </strong>
        </div>
        <div>
          <span>{tr(lang, '结束开放集')}</span>
          <strong>{formatNumber(result.openAtEnd, lang)}</strong>
        </div>
      </div>

      <SectionLabel>{tr(lang, '编译结果')}</SectionLabel>
      <pre className="formula-block formula-block-run">{formula}</pre>

      <SectionLabel>{tr(lang, '运行设置')}</SectionLabel>
      <div className="definition-list">
        <div>
          <span>{tr(lang, '场景')}</span>
          <strong>{tr(lang, map.name)}</strong>
        </div>
        <div>
          <span>{tr(lang, '栅格')}</span>
          <strong>
            {map.width} × {map.height} · {map.cellSize.toFixed(1)} m / {tr(lang, '格')}
          </strong>
        </div>
        <div>
          <span>{tr(lang, result.continuous ? '空间' : '邻域')}</span>
          <strong>{result.continuous ? tr(lang, '连续空间') : cards.diagonal.enabled ? tr(lang, '8 邻域，禁止穿角') : tr(lang, '4 邻域')}</strong>
        </div>
        <div>
          <span>{tr(lang, '启发式')}</span>
          <strong>
            {cards.heuristic.enabled ? `${cards.heuristic.value.toFixed(2)}×` : tr(lang, '关闭')}
          </strong>
        </div>
        <div>
          <span>{tr(lang, '安全半径')}</span>
          <strong>
            {cards.collision.enabled ? `${cards.collision.value.toFixed(2)} ${tr(lang, '格')}` : tr(lang, '关闭')}
          </strong>
        </div>
        <div>
          <span>{tr(lang, '确定性')}</span>
          <strong>{tr(lang, '固定顺序 · seed 0')}</strong>
        </div>
      </div>

      <SectionLabel>{tr(lang, '重播与导出')}</SectionLabel>
      <div className="run-actions">
        <button type="button" className="btn btn-secondary btn-wide" onClick={onReplay}>
          <Icon name="play" size={14} />
          {tr(lang, '重新播放搜索')}
        </button>
        <button type="button" className="btn btn-secondary btn-wide" onClick={onExportJson}>
          <Icon name="download" size={14} />
          {tr(lang, '导出装配 + 指标 JSON')}
        </button>
        <button type="button" className="btn btn-secondary btn-wide" onClick={onExportCsv}>
          <Icon name="download" size={14} />
          {tr(lang, '导出指标 CSV')}
        </button>
        <button type="button" className="btn btn-ghost btn-wide" onClick={onReset}>
          <Icon name="reset" size={14} />
          {tr(lang, '恢复默认装配')}
        </button>
      </div>

      <SectionLabel>{tr(lang, '模型边界')}</SectionLabel>
      <div className="model-note">
        {lang === 'en' ? (
          <>
            <p>
              Current model: 2D grid and continuous space, point robot, no dynamics.
              Length and clearance are converted using {map.cellSize.toFixed(1)} m
              per cell; speed, acceleration and other dynamic metrics are not modeled.
            </p>
            <p>
              The workbench focuses on the full search + cost + hard-constraint +
              bridge pipeline. It is not a numerical reproduction of a specific
              planning stack.
            </p>
          </>
        ) : (
          <>
            <p>
              当前模型是 2D 栅格 + 连续空间、点机器人、无动力学。路径长度和间隙按{' '}
              {map.cellSize.toFixed(1)} m / {tr(lang, '格')}换算；连续模式复用同一障碍场和
              clearance，速度、加速度等动力学指标尚未加入。
            </p>
            <p>
              本工作台聚焦“搜索 + 代价 + 硬约束 + 桥接”的完整链路，不绑定某一种具体规划栈。
            </p>
          </>
        )}
      </div>

      <div className="trust-note">
        <Icon name="check" size={14} />
        {tr(lang, '同一场景 + 同一配方 + 同一 seed，结果可复现。')}
      </div>
      <p className="about-credit">Pathcraft 0.5.1 · © 2026 Kind0419 · MIT License</p>
    </div>
  )
}

function MetricsStrip({
  scale,
  result,
  pending,
  progress,
  onOpen,
}: {
  /** Metres per unit of `pathLength` / `minClearance`. */
  scale: number
  result: PlanResult
  pending: boolean
  progress: number
  onOpen: () => void
}) {
  const lang = useLang()
  const solved = result.status === 'success'
  const lengthM = result.pathLength * scale
  const clearanceM = result.minClearance * scale
  return (
    <div className={`metrics-strip ${pending ? 'is-pending' : ''}`}>
      <div className="strip-metric is-primary">
        <span>{tr(lang, '路径长度')}</span>
        <strong>
          {solved ? lengthM.toFixed(2) : '—'}
          {solved ? <em>m</em> : null}
        </strong>
      </div>
      <div className="strip-metric">
        <span>{tr(lang, '扩展节点')}</span>
        <strong>{formatNumber(result.expanded, lang)}</strong>
      </div>
      <div className="strip-metric">
        <span>{tr(lang, '最小间隙')}</span>
        <strong>
          {solved ? clearanceM.toFixed(2) : '—'}
          {solved ? <em>m</em> : null}
        </strong>
      </div>
      <div className="strip-metric">
        <span>{tr(lang, '求解时间')}</span>
        <strong>
          {result.solveTime.toFixed(1)}
          <em>ms</em>
        </strong>
      </div>
      {pending ? (
        <div className="strip-pending" role="status">
          <span>{tr(lang, '后台求解')}</span>
          <div className="strip-pending-track" aria-hidden="true">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      ) : null}
      <button type="button" className="strip-detail" onClick={onOpen}>
        {tr(lang, '查看指标')}
        <Icon name="chevronDown" size={13} />
      </button>
    </div>
  )
}

function LibraryItem({
  def,
  inRecipe,
  inapplicable,
  onToggle,
  onHoverStart,
  onHoverEnd,
}: {
  def: CardDef
  inRecipe: boolean
  inapplicable: boolean
  onToggle: () => void
  onHoverStart: () => void
  onHoverEnd: () => void
}) {
  const lang = useLang()
  const title = tr(lang, def.title)
  const subtitle = tr(lang, def.subtitle)
  return (
    <button
      type="button"
      className={`library-item ${inRecipe ? 'is-in' : ''} ${inapplicable ? 'is-na' : ''}`}
      style={{ '--card-accent': def.accent } as CSSProperties}
      onClick={onToggle}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      title={
        lang === 'en'
          ? `${title}: ${subtitle} (click to ${inRecipe ? 'remove' : 'add'})`
          : `${def.title}：${def.subtitle}（点击${inRecipe ? '移除' : '加入'}）`
      }
    >
      <span className="library-icon">
        <Icon name={def.icon} size={14} />
      </span>
      <span className="library-copy">
        <strong>{title}</strong>
        <em>{def.param}</em>
      </span>
      {inapplicable ? (
        <span className="library-mark" title={tr(lang, '当前算法不使用这个参数')}>
          {tr(lang, '不适用')}
        </span>
      ) : (
        <span className="library-action">
          <Icon name={inRecipe ? 'check' : 'plus'} size={12} />
        </span>
      )}
    </button>
  )
}

function Timeline({
  result,
  playhead,
  playing,
  speed,
  onPlayhead,
  onPlaying,
  onSpeed,
}: {
  result: PlanResult
  playhead: number
  playing: boolean
  speed: number
  onPlayhead: (value: number) => void
  onPlaying: (value: boolean) => void
  onSpeed: (value: number) => void
}) {
  const lang = useLang()
  const max = Math.max(1, result.events.length)
  const current = Math.min(playhead, result.events.length)
  const atEnd = current >= result.events.length
  const status =
    result.status === 'infeasible'
      ? tr(lang, '不可行')
      : playing
        ? tr(lang, '回放中')
        : atEnd
          ? tr(lang, '已收敛 · 暂停')
          : tr(lang, '已暂停')

  return (
    <footer className="timeline">
      <div className="timeline-status">
        <span
          className={`status-dot ${result.status === 'success' ? 'is-ok' : 'is-bad'}`}
        />
        <strong>{status}</strong>
        <span className="timeline-meta">{result.solveTime.toFixed(1)} ms</span>
      </div>

      <div className="transport">
        <button
          type="button"
          className="play-btn"
          aria-label={playing ? tr(lang, '暂停') : tr(lang, '播放')}
          onClick={() => {
            if (playing) {
              onPlaying(false)
              return
            }
            onPlayhead(0)
            onPlaying(true)
          }}
          disabled={result.events.length === 0}
        >
          <Icon name={playing ? 'pause' : 'play'} size={15} />
        </button>
        <input
          className="range range-timeline"
          type="range"
          min={0}
          max={max}
          step={1}
          value={current}
          aria-label={tr(lang, '搜索回放进度')}
          onChange={(event) => {
            onPlaying(false)
            onPlayhead(Number(event.target.value))
          }}
          style={
            {
              '--fill': `${(current / max) * 100}%`,
            } as CSSProperties
          }
        />
        <span className="transport-count">
          {current} / {result.events.length} {tr(lang, '格')}
        </span>
      </div>

      <div className="speed-control">
        <span>{tr(lang, '速度')}</span>
        {[0.5, 1, 2].map((value) => (
          <button
            key={value}
            type="button"
            className={`speed-btn ${speed === value ? 'is-active' : ''}`}
            onClick={() => onSpeed(value)}
          >
            {value}×
          </button>
        ))}
      </div>
    </footer>
  )
}

export default function App() {
  const [worldId, setWorldId] = useState<WorldId>(INITIAL_RECIPE?.worldId ?? DEFAULT_MAP_ID)
  const world = useMemo(() => resolveWorld(worldId), [worldId])
  const is3D = world.kind !== 'grid2d'
  const worldSize =
    world.kind === 'voxel3d'
      ? `${world.scene.volume.width}×${world.scene.volume.height}×${world.scene.volume.depth}`
      : world.kind === 'field2d'
        ? `${(world.scene.space.bounds.max.x).toFixed(0)}×${(world.scene.space.bounds.max.y).toFixed(0)} m`
        : world.kind === 'field3d'
          ? `${(world.scene.space.bounds.max.x).toFixed(0)}×${(world.scene.space.bounds.max.y).toFixed(0)}×${(world.scene.space.bounds.max.z).toFixed(0)} m`
          : ''
  // The 2D pipeline still needs a GridMap; in a 3D world it is simply not used
  // for solving, but several panels (history, metrics) want a valid object.
  const mapId: MapId = world.kind === 'grid2d' ? world.map.id : DEFAULT_MAP_ID
  const [cards, setCards] = useState<CardsState>(
    () => INITIAL_RECIPE?.cards ?? createDefaultCards(),
  )
  const [selectedCardId, setSelectedCardId] = useState<CardId | null>(null)
  const [hoverCard, setHoverCard] = useState<CardId | null>(null)
  const [rightTab, setRightTab] = useState<RightTab>('recipe')
  const [lang, setLang] = useState<Lang>(() =>
    readSetting('pathcraft:lang:v1') === 'en' ? 'en' : 'zh',
  )
  const [recipeOrder, setRecipeOrder] = useState<CardId[]>(
    () => INITIAL_RECIPE?.order ?? createDefaultRecipeOrder(),
  )
  const [recipeWidth, setRecipeWidth] = useState(() => {
    const saved = Number(readSetting('pathcraft:recipe-width:v3'))
    return Number.isFinite(saved) && saved >= 310 ? Math.min(560, saved) : 380
  })
  const [resizing, setResizing] = useState(false)
  const [draggedCard, setDraggedCard] = useState<CardId | null>(null)
  const [dragOverCard, setDragOverCard] = useState<CardId | null>(null)
  const recipeSlotRefs = useRef<Map<CardId, HTMLDivElement>>(new Map())
  const flipPositionsRef = useRef<Map<CardId, number> | null>(null)
  const draggedCardRef = useRef<CardId | null>(null)
  const dragDroppedRef = useRef(false)
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null)
  const [showExpanded, setShowExpanded] = useState(true)
  const [showPath, setShowPath] = useState(true)
  const [showGhost, setShowGhost] = useState(true)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [replayNonce, setReplayNonce] = useState(0)
  const [ghostPath, setGhostPath] = useState<Point[]>([])
  const [ghostContinuous, setGhostContinuous] = useState(false)
  // True from pointerdown to pointerup on a slider or a map marker. The route is
  // recomputed on every tick / every cell the pointer crosses, so without this
  // the "previous route" would follow the drag and end up identical to the live
  // one -- a dashed line drawn exactly under the solid one, which reads as no
  // comparison at all. While a gesture runs the ghost is frozen at the route the
  // drag started from, which is the baseline you are actually editing against.
  const gestureRef = useRef(false)
  const [previousMetrics, setPreviousMetrics] = useState<MetricSnapshot | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [editedCells, setEditedCells] = useState<Uint8Array | null>(
    () => INITIAL_RECIPE?.cells ?? null,
  )
  const [customSize, setCustomSize] = useState<{ width: number; height: number } | null>(
    () => INITIAL_RECIPE?.size ?? null,
  )
  const [editingMap, setEditingMap] = useState(false)
  const [brushMode, setBrushMode] = useState<'wall' | 'erase'>('wall')
  const [brushSize, setBrushSize] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => new Set(['bridge']))
  const [leftWidth, setLeftWidth] = useState(270)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [resizingLeft, setResizingLeft] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [bottomHeight, setBottomHeight] = useState(64)
  const [bottomCollapsed, setBottomCollapsed] = useState(false)
  const [resizingBottom, setResizingBottom] = useState(false)
  const leftResizeStartRef = useRef<{ x: number; width: number } | null>(null)
  const bottomResizeStartRef = useRef<{ y: number; height: number } | null>(null)

  const baseMap = useMemo(() => getMap(mapId), [mapId])
  const map = useMemo(
    () =>
      editedCells
        ? mapFromCells(
            baseMap,
            editedCells,
            customSize?.width ?? baseMap.width,
            customSize?.height ?? baseMap.height,
          )
        : baseMap,
    [baseMap, editedCells, customSize],
  )
  const isCustomMap = editedCells !== null || customSize !== null
  const [sizeDraft, setSizeDraft] = useState(() => ({
    width: INITIAL_RECIPE?.size?.width ?? baseMap.width,
    height: INITIAL_RECIPE?.size?.height ?? baseMap.height,
  }))
  useEffect(() => {
    setSizeDraft({ width: map.width, height: map.height })
  }, [map.width, map.height, mapId])
  const [start, setStart] = useState<Point>(
    () => INITIAL_RECIPE?.start ?? { ...map.start },
  )
  const [goal, setGoal] = useState<Point>(
    () => INITIAL_RECIPE?.goal ?? { ...map.goal },
  )
  const [editMode, setEditMode] = useState<'none' | 'start' | 'goal'>('none')
  // Endpoints for 3D / field worlds live in world units, independent of the 2D
  // start/goal cells. Switching worlds resets them to that scene's defaults.
  const [start3, setStart3] = useState<Vec3>(
    () => INITIAL_RECIPE?.start3 ?? worldEndpoints(world).start,
  )
  const [goal3, setGoal3] = useState<Vec3>(
    () => INITIAL_RECIPE?.goal3 ?? worldEndpoints(world).goal,
  )
  const activeMap = useMemo(
    () => ({ ...map, start, goal }),
    [map, start, goal],
  )
  const effectiveCards = useMemo(() => {
    const next = { ...cards }
    const included = new Set(recipeOrder)
    for (const def of CARD_DEFS) {
      if (!included.has(def.id)) {
        next[def.id] = { ...next[def.id], enabled: false }
      }
    }
    return next
  }, [cards, recipeOrder])
  const endpoints = useMemo(
    () =>
      is3D
        ? { start: start3, goal: goal3 }
        : {
            start: { x: start.x, y: start.y, z: 0 },
            goal: { x: goal.x, y: goal.y, z: 0 },
          },
    [is3D, start3, goal3, start, goal],
  )
  const planState = useWorldPlan(
    world,
    activeMap,
    effectiveCards,
    recipeOrder,
    endpoints,
    Math.round(cards.strategy.value),
  )
  const result = planState.result
  const previousRunRef = useRef<{ result: PlanResult; mapId: MapId } | null>(null)

  useEffect(() => {
    const previous = previousRunRef.current
    if (previous && previous.result !== result && previous.mapId === mapId) {
      // While a gesture is in flight the intermediate solves are not baselines,
      // they are this gesture's own ticks; only record the first step, which is
      // the state the user pressed down on.
      if (!gestureRef.current) {
        setGhostPath(previous.result.path)
        setGhostContinuous(previous.result.continuous)
        setPreviousMetrics(metricSnapshot(previous.result, activeMap))
      }
    }
    previousRunRef.current = { result, mapId }
  }, [result, activeMap, mapId])

  /**
   * Freezes the comparison baseline at the first frame of a drag gesture: the
   * route that is on screen when the pointer goes down. Without the freeze the
   * baseline would chase the live route tick by tick and land exactly on top of
   * it, which reads as no comparison at all.
   */
  const beginGesture = useCallback(() => {
    gestureRef.current = true
    setGhostPath(result.path)
    setGhostContinuous(result.continuous)
    setPreviousMetrics(metricSnapshot(result, activeMap))
    setPlaying(false)
    setPlayhead(result.events.length)
  }, [result, activeMap])

  /** Unfreezes it; the next solve then becomes the new baseline as usual. */
  const endGesture = useCallback(() => {
    gestureRef.current = false
    setReplayNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    setPlaying(false)
    setPlayhead(result.events.length)
  }, [result])

  useEffect(() => {
    if (!playing || result.events.length === 0) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPlayhead(result.events.length)
      setPlaying(false)
      return
    }
    let frame = 0
    const total = result.events.length
    // Long enough for the route to visibly travel from start to goal, but
    // capped so a giant expansion does not turn playback into a wait.
    const duration = Math.min(3800, Math.max(1100, 900 + Math.sqrt(total) * 140)) / speed
    const startedAt = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 1.5)
      setPlayhead(Math.max(1, Math.round(eased * total)))
      if (progress < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        setPlayhead(total)
        setPlaying(false)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, result, speed, replayNonce])

  useLayoutEffect(() => {
    const previousTops = flipPositionsRef.current
    if (!previousTops) return
    flipPositionsRef.current = null
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    recipeSlotRefs.current.forEach((element, id) => {
      const previousTop = previousTops.get(id)
      if (previousTop === undefined) return
      element.getAnimations().forEach((animation) => animation.cancel())
      const nextTop = element.getBoundingClientRect().top
      const delta = previousTop - nextTop
      if (Math.abs(delta) < 0.5) return
      element.animate(
        [
          { transform: `translateY(${delta}px)` },
          { transform: 'translateY(0)' },
        ],
        {
          duration: 260,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        },
      )
    })
  }, [recipeOrder])

  useEffect(() => {
    const hash = `#r=${serializeRecipe(
      worldId,
      cards,
      recipeOrder,
      start,
      goal,
      is3D ? start3 : null,
      is3D ? goal3 : null,
      editedCells,
      customSize,
    )}`
    // Inside a sandboxed iframe (or a file:// page opened in some viewers) a
    // history write can be refused, and an effect that throws blanks the app.
    try {
      window.history.replaceState(null, '', hash)
    } catch {
      // The share link still works when copied from the export menu.
    }
  }, [worldId, is3D, start3, goal3, cards, recipeOrder, start, goal, editedCells, customSize])

  useEffect(() => {
    writeSetting('pathcraft:lang:v1', lang)
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hans'
    document.title =
      lang === 'en'
        ? 'Pathcraft · Path-planning workbench'
        : 'Pathcraft · 路径算法拼装台'
  }, [lang])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (!resizing) return
    const onMove = (event: PointerEvent) => {
      const start = resizeStartRef.current
      if (!start) return
      const raw = start.width - (event.clientX - start.x)
      if (raw < 250) {
        setRightCollapsed(true)
        setResizing(false)
        return
      }
      setRecipeWidth(Math.max(310, Math.min(560, raw)))
    }
    const onUp = () => {
      setResizing(false)
      resizeStartRef.current = null
      writeSetting('pathcraft:recipe-width:v3', String(recipeWidth))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizing, recipeWidth])

  useEffect(() => {
    if (!resizingLeft) return
    const onMove = (event: PointerEvent) => {
      const start = leftResizeStartRef.current
      if (!start) return
      const raw = start.width + (event.clientX - start.x)
      if (raw < 150) {
        setLeftCollapsed(true)
        setResizingLeft(false)
        return
      }
      setLeftWidth(Math.max(170, Math.min(320, raw)))
    }
    const onUp = () => {
      setResizingLeft(false)
      leftResizeStartRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizingLeft, leftWidth])

  useEffect(() => {
    if (!resizingBottom) return
    const onMove = (event: PointerEvent) => {
      const start = bottomResizeStartRef.current
      if (!start) return
      const raw = start.height - (event.clientY - start.y)
      if (raw < 42) {
        setBottomCollapsed(true)
        setResizingBottom(false)
        return
      }
      setBottomHeight(Math.max(60, Math.min(152, raw)))
    }
    const onUp = () => {
      setResizingBottom(false)
      bottomResizeStartRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizingBottom, bottomHeight])

  const enabledCount = recipeOrder.filter((id) => cards[id].enabled).length
  const infeasibleDetail =
    result.status === 'infeasible'
      ? diagnoseInfeasible(effectiveCards, result)
      : null
  const formula = compileFormula(effectiveCards, recipeOrder)
  const selectedState = selectedCardId ? effectiveCards[selectedCardId] : null
  const stageLabel =
    result.continuous
      ? effectiveCards.smooth.enabled || effectiveCards.round.enabled
        ? '连续规划 · 桥接'
        : '连续规划'
      : effectiveCards.smooth.enabled || effectiveCards.round.enabled
        ? '图搜索 · 桥接'
        : '图搜索'

  function updateCard(id: CardId, patch: Partial<{ enabled: boolean; value: number }>) {
    setCards((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }))
  }

  function selectCard(id: CardId) {
    setSelectedCardId(id)
    setRightTab('card')
  }

  function toggleGroup(id: string) {
    setClosedGroups((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function addToRecipe(id: CardId) {
    if (recipeOrder.includes(id)) return
    setRecipeOrder((order) => [...order, id])
    updateCard(id, { enabled: true })
  }

  function removeFromRecipe(id: CardId) {
    setRecipeOrder((order) => order.filter((entry) => entry !== id))
    if (selectedCardId === id) setSelectedCardId(null)
  }

  function toggleRecipeCard(id: CardId) {
    if (recipeOrder.includes(id)) removeFromRecipe(id)
    else addToRecipe(id)
  }

  function animateRecipeOrder(nextOrder: CardId[]) {
    const positions = new Map<CardId, number>()
    recipeSlotRefs.current.forEach((element, id) => {
      positions.set(id, element.getBoundingClientRect().top)
    })
    flipPositionsRef.current = positions
    setRecipeOrder(nextOrder)
  }

  function moveRecipeCard(id: CardId, targetIndex: number) {
    const currentIndex = recipeOrder.indexOf(id)
    if (currentIndex < 0) return
    const next = recipeOrder.filter((entry) => entry !== id)
    const insertAt =
      targetIndex > currentIndex ? targetIndex - 1 : targetIndex
    next.splice(Math.max(0, Math.min(next.length, insertAt)), 0, id)
    animateRecipeOrder(next)
  }

  function handleRecipeDragOver(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault()
    const activeDrag = draggedCardRef.current
    if (!activeDrag) return

    const list = event.currentTarget
    const listRect = list.getBoundingClientRect()
    const edge = 34
    if (event.clientY < listRect.top + edge) list.scrollTop -= 14
    else if (event.clientY > listRect.bottom - edge) list.scrollTop += 14

    // Exclude the dragged card from the lane geometry.  Including it makes
    // the insertion point flip back and forth around the card center.
    const others = recipeOrder.filter((id) => id !== activeDrag)
    const lanes = others
      .map((id) => {
        const element = recipeSlotRefs.current.get(id)
        return element ? { id, rect: element.getBoundingClientRect() } : null
      })
      .filter((lane): lane is { id: CardId; rect: DOMRect } => Boolean(lane))
    if (lanes.length === 0) return

    let insertIndex = lanes.length
    for (let i = 0; i < lanes.length; i += 1) {
      const lane = lanes[i]
      if (event.clientY < lane.rect.top + lane.rect.height / 2) {
        insertIndex = i
        break
      }
    }

    const currentIndex = recipeOrder.indexOf(activeDrag)
    if (insertIndex === currentIndex) {
      setDragOverCard(null)
      return
    }

    const nextOrder = [...others]
    nextOrder.splice(insertIndex, 0, activeDrag)
    setDragOverCard(null)
    animateRecipeOrder(nextOrder)
  }

  function quickToggle(id: CardId) {
    if (!recipeOrder.includes(id)) {
      addToRecipe(id)
      setSelectedCardId(id)
      setReplayNonce((value) => value + 1)
      return
    }
    updateCard(id, { enabled: !cards[id].enabled })
    setSelectedCardId(id)
    setReplayNonce((value) => value + 1)
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    resizeStartRef.current = { x: event.clientX, width: recipeWidth }
    setResizing(true)
  }

  function beginLeftResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    leftResizeStartRef.current = { x: event.clientX, width: leftWidth }
    setResizingLeft(true)
  }

  function beginBottomResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    bottomResizeStartRef.current = { y: event.clientY, height: bottomHeight }
    setResizingBottom(true)
  }

  function paintMapCell(cx: number, cy: number) {
    if (!editingMap) return
    setEditedCells((current) => {
      const next = new Uint8Array(current ?? map.cells)
      const offset = Math.floor(brushSize / 2)
      for (let dy = -offset; dy < brushSize - offset; dy += 1) {
        for (let dx = -offset; dx < brushSize - offset; dx += 1) {
          const x = cx + dx
          const y = cy + dy
          if (x <= 0 || y <= 0 || x >= map.width - 1 || y >= map.height - 1) {
            continue
          }
          if (
            (x === start.x && y === start.y) ||
            (x === goal.x && y === goal.y)
          ) {
            continue
          }
          next[y * map.width + x] = brushMode === 'wall' ? 1 : 0
        }
      }
      return next
    })
  }

  function clearMap() {
    const cells = new Uint8Array(map.width * map.height)
    for (let x = 0; x < map.width; x += 1) {
      cells[x] = 1
      cells[(map.height - 1) * map.width + x] = 1
    }
    for (let y = 0; y < map.height; y += 1) {
      cells[y * map.width] = 1
      cells[y * map.width + map.width - 1] = 1
    }
    cells[start.y * map.width + start.x] = 0
    cells[goal.y * map.width + goal.x] = 0
    setEditedCells(cells)
  }

  function applyMapSize() {
    const next = clampMapSize(sizeDraft.width, sizeDraft.height)
    const source = editedCells ?? map.cells
    const cells = resizeCells(
      source,
      map.width,
      map.height,
      next.width,
      next.height,
    )

    let nextStart = findFreeCell(cells, next.width, next.height, {
      x: start.x + Math.floor((next.width - map.width) / 2),
      y: start.y + Math.floor((next.height - map.height) / 2),
    })
    let nextGoal = findFreeCell(cells, next.width, next.height, {
      x: goal.x + Math.floor((next.width - map.width) / 2),
      y: goal.y + Math.floor((next.height - map.height) / 2),
    })
    if (nextStart.x === nextGoal.x && nextStart.y === nextGoal.y) {
      nextGoal = findFreeCell(cells, next.width, next.height, {
        x: next.width - 3,
        y: next.height - 3,
      })
    }
    cells[nextStart.y * next.width + nextStart.x] = 0
    cells[nextGoal.y * next.width + nextGoal.x] = 0

    setEditedCells(cells)
    setCustomSize(next)
    setSizeDraft(next)
    setStart(nextStart)
    setGoal(nextGoal)
    setEditingMap(true)
    setToast(
      lang === 'en'
        ? `Map resized to ${next.width} × ${next.height}`
        : `地图规格已更新为 ${next.width} × ${next.height}`,
    )
  }

  function restorePresetMap() {
    setEditedCells(null)
    setCustomSize(null)
    setStart({ ...baseMap.start })
    setGoal({ ...baseMap.goal })
    setEditingMap(false)
    setEditMode('none')
  }

  function handleWorldChange(nextId: WorldId) {
    setWorldId(nextId)
    const nextWorld = resolveWorld(nextId)
    if (nextWorld.kind !== 'grid2d') {
      const ends = worldEndpoints(nextWorld)
      setStart3(ends.start)
      setGoal3(ends.goal)
      setEditedCells(null)
      setCustomSize(null)
      setEditingMap(false)
      setEditMode('none')
      setGhostPath([])
      setGhostContinuous(false)
      setPreviousMetrics(null)
      setPlayhead(0)
      setReplayNonce((value) => value + 1)
      // Algorithms without a 3D implementation would otherwise render an empty
      // canvas with an "unsupported" note; land on A* instead.
      const dim = nextWorld.kind === 'field3d' || nextWorld.kind === 'voxel3d' ? 3 : 2
      if (!supportsDim(solverFor(cards), dim) || Math.round(cards.strategy.value) > 5) {
        setCards((prev) => ({ ...prev, strategy: { ...prev.strategy, value: 0 } }))
      }
      return
    }
    const nextMap = nextWorld.map
    setWorldId(nextWorld.map.id)
    setEditedCells(null)
    setCustomSize(null)
    setEditingMap(false)
    setStart({ ...nextMap.start })
    setGoal({ ...nextMap.goal })
    setEditMode('none')
    setGhostPath([])
    setGhostContinuous(false)
    setPreviousMetrics(null)
    setPlayhead(0)
    setReplayNonce((value) => value + 1)
  }

  function handleReset() {
    const resetMap = getMap(DEFAULT_MAP_ID)
    setCards(createDefaultCards())
    setWorldId(DEFAULT_MAP_ID)
    setStart3(worldEndpoints(resolveWorld(DEFAULT_MAP_ID)).start)
    setGoal3(worldEndpoints(resolveWorld(DEFAULT_MAP_ID)).goal)
    setEditedCells(null)
    setCustomSize(null)
    setEditingMap(false)
    setStart({ ...resetMap.start })
    setGoal({ ...resetMap.goal })
    setEditMode('none')
    setRecipeOrder(createDefaultRecipeOrder())
    setSelectedCardId(null)
    setRightTab('recipe')
    setGhostPath([])
    setGhostContinuous(false)
    setPreviousMetrics(null)
    setPlayhead(0)
    setReplayNonce((value) => value + 1)
    setToast(tr(lang, '已恢复默认装配'))
  }

  function replay() {
    setPlayhead(0)
    setPlaying(true)
    setReplayNonce((value) => value + 1)
  }

  function exportJson() {
    const payload = {
      app: 'Pathcraft',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      map: {
        id: map.id,
        name: map.name,
        width: map.width,
        height: map.height,
        cellSize: map.cellSize,
        start: activeMap.start,
        goal: activeMap.goal,
        custom: isCustomMap,
        cells: editedCells ? encodeCells(editedCells) : undefined,
      },
      recipe: cards,
      recipeOrder,
      metrics: {
        status: result.status,
        algorithm: localizeAlgorithm(lang, result.algorithmLabel),
        pathLengthM: result.pathLength * map.cellSize,
        minClearanceM: result.minClearance * map.cellSize,
        expanded: result.expanded,
        expandedCells: result.expandedCells,
        solveTimeMs: result.solveTime,
        totalCost: result.totalCost,
        costBreakdown: result.cost,
      },
      path: result.path.map((point) => ({
        x: Number((point.x * map.cellSize).toFixed(4)),
        y: Number((point.y * map.cellSize).toFixed(4)),
      })),
    }
    downloadFile(
      `pathcraft-${map.id}-${Date.now()}.json`,
      JSON.stringify(payload, null, 2),
      'application/json',
    )
    setToast(tr(lang, '装配 JSON 已导出'))
  }

  function exportCsv() {
    const rows: Array<Array<string | number>> = [
      ['metric', 'value', 'unit'],
      ['map', map.name, ''],
      ['start', `${start.x},${start.y}`, 'cell'],
      ['goal', `${goal.x},${goal.y}`, 'cell'],
      ['algorithm', localizeAlgorithm(lang, result.algorithmLabel), ''],
      ['status', result.status, ''],
      ['path_length', (result.pathLength * map.cellSize).toFixed(3), 'm'],
      ['min_clearance', (result.minClearance * map.cellSize).toFixed(3), 'm'],
      ['expanded_states', result.expanded, ''],
      ['covered_cells', result.expandedCells, ''],
      ['solve_time', result.solveTime.toFixed(3), 'ms'],
      ['total_cost', result.totalCost.toFixed(3), 'cost'],
      ['length_cost', result.cost.length.toFixed(3), 'cost'],
      ['clearance_cost', result.cost.clearance.toFixed(3), 'cost'],
      ['turn_cost', result.cost.turn.toFixed(3), 'cost'],
      ['bias_cost', result.cost.bias.toFixed(3), 'cost'],
    ]
    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n')
    downloadFile(
      `pathcraft-${map.id}-${Date.now()}.csv`,
      csv,
      'text/csv;charset=utf-8',
    )
    setToast(tr(lang, '指标 CSV 已导出'))
  }

  async function share() {
    const url = window.location.href
    try {
      await navigator.clipboard.writeText(url)
      setToast(tr(lang, '分享链接已复制'))
    } catch {
      setToast(tr(lang, '复制失败，请手动复制地址栏'))
    }
  }

  return (
    <LangContext.Provider value={lang}>
    <div
      className={`app-shell ${
        resizing || resizingLeft || resizingBottom ? 'is-pane-resizing' : ''
      }`}
      style={
        {
          "--bottom-height": `${bottomCollapsed ? 18 : bottomHeight}px`,
        } as CSSProperties
      }
    >
      <header className="topbar">
        <div className="brand">
          <strong>Pathcraft</strong>
          <span>{tr(lang, '路径算法拼装台')}</span>
        </div>

        <div className="topbar-center">
          <div className="scenario-switch" role="group" aria-label={tr(lang, '选择场景')}>
            {WORLD_GROUPS.map((group) => (
              <div className="scenario-group" key={group.key}>
                {group.ids.map((id) => {
                  const meta = worldMeta(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      className={worldId === id ? 'is-active' : ''}
                      title={lang === 'en' ? meta.blurbEn : meta.blurb}
                      onClick={() => handleWorldChange(id)}
                    >
                      {lang === 'en' ? meta.nameEn : meta.name}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="topbar-meta">
          <span className="stage-pill">
            <span className="stage-dot" />
            {lang === 'en'
              ? result.continuous
                ? 'Continuous'
                : 'Graph search'
              : stageLabel}
          </span>
          <span className="topbar-divider" />
          <span className="topbar-grid">
            {is3D ? `${worldSize} · ${tr(lang, '三维')}` : `${map.width}×${map.height} · ${map.cellSize.toFixed(1)} m`}
          </span>
        </div>

        <div className="lang-switch" role="group" aria-label="Language">
          <button
            type="button"
            className={lang === 'zh' ? 'is-active' : ''}
            onClick={() => setLang('zh')}
          >
            中文
          </button>
          <button
            type="button"
            className={lang === 'en' ? 'is-active' : ''}
            onClick={() => setLang('en')}
          >
            EN
          </button>
        </div>

        <div className="topbar-actions">
          <button type="button" className="btn btn-ghost" onClick={handleReset}>
            <Icon name="reset" size={14} />
            {tr(lang, '重置')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={exportJson}>
            <Icon name="download" size={14} />
            {tr(lang, '导出')}
          </button>
          <button type="button" className="btn btn-primary" onClick={share}>
            <Icon name="share" size={14} />
            {tr(lang, '分享')}
          </button>
        </div>
      </header>

      <main
        className="workspace"
        style={
          {
            '--library-width': `${leftCollapsed ? 18 : leftWidth}px`,
            '--recipe-width': `${rightCollapsed ? 18 : recipeWidth}px`,
          } as CSSProperties
        }
      >
        {leftCollapsed ? (
          <button
            type="button"
            className="pane-tab pane-tab-left"
            title="展开卡片库"
            onClick={() => setLeftCollapsed(false)}
          >
            <Icon name="chevronDown" size={13} />
          </button>
        ) : (
        <aside className="sidebar library-panel">
          <div className="panel-head">
            <div>
              <h1>{tr(lang, '组件库')}</h1>
              <p className="panel-sub">{CARD_DEFS.length} {tr(lang, '个参数模块')}</p>
            </div>
            <div className="panel-head-actions">

              <button
                type="button"
                className="panel-collapse"
                title={tr(lang, '收起卡片库')}
                aria-label={tr(lang, '收起卡片库')}
                onClick={() => setLeftCollapsed(true)}
              >
                <Icon name="chevronDown" size={13} />
              </button>
            </div>
          </div>

          <div className="library-scroll">
            {CARD_GROUPS.map((group) => {
              const groupCards = CARD_DEFS.filter((def) => def.group === group.id)
              const collapsed = closedGroups.has(group.id)
              return (
                <section
                  className={`card-group ${collapsed ? 'is-collapsed' : ''}`}
                  key={group.id}
                >
                  <button
                    type="button"
                    className="group-label"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span>{tr(lang, group.label)}</span>
                    <em>{groupCards.length}</em>
                    <Icon name="chevronDown" size={11} />
                  </button>
                  <div className="library-items">
                    <div>
                      {groupCards.map((def) => (
                        <LibraryItem
                          key={def.id}
                          def={def}
                          inRecipe={recipeOrder.includes(def.id)}
                          inapplicable={!cardApplies(def.id, planState.solver)}
                          onToggle={() => toggleRecipeCard(def.id)}
                          onHoverStart={() => setHoverCard(def.id)}
                          onHoverEnd={() => setHoverCard(null)}
                        />
                      ))}
                    </div>
                  </div>
                </section>
              )
            })}
          </div>

          <div className="sidebar-credit">© 2026 Kind0419</div>

          <div
            className="pane-resizer library-resizer"
            role="separator"
            aria-orientation="vertical"
            title={tr(lang, '拖动调整卡片库宽度')}
            onPointerDown={beginLeftResize}
          />
        </aside>
        )}

        <section className="stage">
          <div className="stage-head">
            <div className="stage-title">
              <h2>
                {tr(lang, map.name)}
                {isCustomMap ? <span className="custom-map-badge">{tr(lang, '已编辑')}</span> : null}
              </h2>
              <p>{tr(lang, map.description)}</p>
              {result.continuous ? (
                <span className="stage-note">
                  {lang === 'en'
                    ? 'Continuous mode ignores heuristic, neighborhood, corner-cut and U-turn cards. Clearance, length, budget and post-processing still apply.'
                    : '连续模式不参与：启发式、邻域、允许切角、禁止掉头、最大转角、目标容差；间隙、长度、预算与后处理仍然生效。'}
                </span>
              ) : null}
            </div>
            <div className="stage-actions">
              <span className="stage-algorithm">{localizeAlgorithm(lang, result.algorithmLabel)}</span>
                <span className={`stage-space ${result.continuous ? 'is-continuous' : ''}`}>
                  {tr(lang, result.continuous ? '连续空间' : '栅格空间')}
                </span>
              <span className={result.status === 'success' ? 'is-ok' : 'is-bad'}>
                <span
                  className={`status-dot ${
                    result.status === 'success' ? 'is-ok' : 'is-bad'
                  }`}
                />
                {result.status === 'success' ? tr(lang, '可行') : tr(lang, '不可行')}
              </span>
            </div>
          </div>

          <div className="canvas-toolbar">
            <div className="layer-switch" role="group" aria-label={tr(lang, '图层显示')}>
              <button
                type="button"
                className={`layer-btn ${showExpanded ? 'is-on' : ''}`}
                aria-pressed={showExpanded}
                title={showExpanded ? tr(lang, '搜索点：显示中，点击隐藏') : tr(lang, '搜索点：已隐藏，点击显示')}
                onClick={() => setShowExpanded((value) => !value)}
              >
                <Icon name={showExpanded ? 'eye' : 'eyeOff'} size={12} />
                <span>{tr(lang, '搜索')}</span>
                <em>{showExpanded ? tr(lang, '开') : tr(lang, '关')}</em>
              </button>
              <button
                type="button"
                className={`layer-btn ${showPath ? 'is-on' : ''}`}
                aria-pressed={showPath}
                title={showPath ? tr(lang, '路径：显示中，点击隐藏') : tr(lang, '路径：已隐藏，点击显示')}
                onClick={() => setShowPath((value) => !value)}
              >
                <Icon name={showPath ? 'eye' : 'eyeOff'} size={12} />
                <span>{tr(lang, '路径')}</span>
                <em>{showPath ? tr(lang, '开') : tr(lang, '关')}</em>
              </button>
              {!is3D ? (
                <button
                  type="button"
                  className={`layer-btn ${showGhost ? 'is-on' : ''}`}
                  aria-pressed={showGhost}
                  title={showGhost ? tr(lang, '旧路径：显示中，点击隐藏') : tr(lang, '旧路径：已隐藏，点击显示上一版结果')}
                  onClick={() => setShowGhost((value) => !value)}
                >
                  <Icon name={showGhost ? 'eye' : 'eyeOff'} size={12} />
                  <span>{tr(lang, '旧路径')}</span>
                  <em>{showGhost ? tr(lang, '开') : tr(lang, '关')}</em>
                </button>
              ) : null}
            </div>
            <div className="edit-points" role="group" aria-label={tr(lang, '编辑起点终点')}>
              <button
                type="button"
                className={editMode === 'start' ? 'is-active' : ''}
                onClick={() => {
                  setEditingMap(false)
                  setEditMode(editMode === 'start' ? 'none' : 'start')
                }}
              >
                <Icon name="target" size={12} />
                {tr(lang, '起点')}
              </button>
              <button
                type="button"
                className={editMode === 'goal' ? 'is-active' : ''}
                onClick={() => {
                  setEditingMap(false)
                  setEditMode(editMode === 'goal' ? 'none' : 'goal')
                }}
              >
                <Icon name="target" size={12} />
                {tr(lang, '终点')}
              </button>
            </div>
            {!is3D ? (
              <button
                type="button"
                className={`map-edit-toggle ${editingMap ? 'is-active' : ''}`}
                aria-pressed={editingMap}
                title={editingMap ? tr(lang, '退出地图编辑') : tr(lang, '编辑 2D 栅格地图')}
                onClick={() => {
                  setEditingMap((value) => !value)
                  setEditMode('none')
                }}
              >
                <Icon name="edit" size={12} />
                {tr(lang, '编辑')}
              </button>
            ) : null}
            <button
              type="button"
              className={`map-edit-toggle focus-toggle ${
                leftCollapsed && rightCollapsed ? 'is-active' : ''
              }`}
              title={
                leftCollapsed && rightCollapsed
                  ? tr(lang, '退出专注画布')
                  : tr(lang, '收起两侧面板，专注画布')
              }
              onClick={() => {
                const focus = !(leftCollapsed && rightCollapsed)
                setLeftCollapsed(focus)
                setRightCollapsed(focus)
              }}
            >
              {leftCollapsed && rightCollapsed ? tr(lang, '退出专注') : tr(lang, '专注')}
            </button>
            <span className="canvas-toolbar-hint">
              {is3D
                ? editMode === 'start'
                  ? tr(lang, '在地面点击放置起点')
                  : editMode === 'goal'
                    ? tr(lang, '在地面点击放置终点')
                    : tr(lang, '拖动旋转视角，滚轮缩放')
                : editingMap
                  ? tr(lang, '编辑模式 · 在画布上拖动绘制，2D 栅格')
                  : editMode === 'start'
                    ? tr(lang, '点击地图放置起点，或直接拖动 S')
                    : editMode === 'goal'
                      ? tr(lang, '点击地图放置终点，或直接拖动 G')
                      : ''}
            </span>
            {!is3D ? (
            <div className="zoom-control" role="group" aria-label={tr(lang, '画布缩放')}>
              <button
                type="button"
                aria-label={tr(lang, '缩小画布')}
                onClick={() => setZoom((value) => Math.max(0.8, value - 0.05))}
              >
                −
              </button>
              <button
                type="button"
                className="zoom-value"
                title={tr(lang, '重置缩放')}
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                aria-label={tr(lang, '放大画布')}
                onClick={() => setZoom((value) => Math.min(1.05, value + 0.05))}
              >
                +
              </button>
            </div>
            ) : null}
            <span className="canvas-toolbar-meta">
              {is3D ? `1.0 m / ${tr(lang, '体素')}` : `${map.cellSize.toFixed(1)} m / ${tr(lang, '格')}`}
            </span>
          </div>

          {editingMap ? (
            <div className="edit-bar">
              <span className="edit-badge">{tr(lang, '2D 栅格')}</span>
              <div className="edit-modes">
                <button
                  type="button"
                  className={brushMode === 'wall' ? 'is-active' : ''}
                  onClick={() => setBrushMode('wall')}
                >
                  <Icon name="edit" size={12} />
                  {tr(lang, '画墙')}
                </button>
                <button
                  type="button"
                  className={brushMode === 'erase' ? 'is-active' : ''}
                  onClick={() => setBrushMode('erase')}
                >
                  <Icon name="eraser" size={12} />
                  {tr(lang, '擦除')}
                </button>
              </div>
              <div className="brush-sizes">
                <span>{tr(lang, '笔刷')}</span>
                {[1, 3, 5].map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={brushSize === size ? 'is-active' : ''}
                    onClick={() => setBrushSize(size)}
                  >
                    {size}
                  </button>
                ))}
              </div>
              <div className="map-size-editor">
                <span>{tr(lang, '规格')}</span>
                <input
                  type="number"
                  min={MAP_LIMITS.minWidth}
                  max={MAP_LIMITS.maxWidth}
                  value={sizeDraft.width}
                  aria-label={lang === 'en' ? 'Map width in cells' : '地图列数'}
                  onChange={(event) =>
                    setSizeDraft((current) => ({
                      ...current,
                      width: Number(event.target.value),
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') applyMapSize()
                  }}
                />
                <span>×</span>
                <input
                  type="number"
                  min={MAP_LIMITS.minHeight}
                  max={MAP_LIMITS.maxHeight}
                  value={sizeDraft.height}
                  aria-label={lang === 'en' ? 'Map height in cells' : '地图行数'}
                  onChange={(event) =>
                    setSizeDraft((current) => ({
                      ...current,
                      height: Number(event.target.value),
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') applyMapSize()
                  }}
                />
                <button type="button" onClick={applyMapSize}>
                  {tr(lang, '应用')}
                </button>
                <em>
                  {MAP_LIMITS.minWidth}–{MAP_LIMITS.maxWidth} ×{' '}
                  {MAP_LIMITS.minHeight}–{MAP_LIMITS.maxHeight}
                </em>
              </div>
              <div className="edit-actions">
                <button type="button" onClick={clearMap}>
                  <Icon name="trash" size={12} />
                  {tr(lang, '清空')}
                </button>
                <button type="button" onClick={restorePresetMap}>
                  <Icon name="reset" size={12} />
                  {tr(lang, '恢复预设')}
                </button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => setEditingMap(false)}
                >
                  <Icon name="check" size={12} />
                  {tr(lang, '完成')}
                </button>
              </div>
            </div>
          ) : null}


          <div
            className={`canvas-area ${
              result.status === 'infeasible' ? 'is-infeasible' : ''
            }`}
          >
            {world.kind === 'grid2d' ? (
              <CanvasView
                map={activeMap}
                cards={effectiveCards}
                result={result}
                playhead={playhead}
                ghostPath={ghostPath}
                ghostContinuous={ghostContinuous}
                hoverCard={hoverCard}
                showExpanded={showExpanded}
                showTrail={planState.solver.family !== 'meta'}
                showPath={showPath}
                showGhost={showGhost}
                editMode={editMode}
                onStartChange={setStart}
                onGoalChange={setGoal}
                onMarkerDrag={(active) => (active ? beginGesture() : endGesture())}
                onPlacePoint={() => setEditMode('none')}
                onInvalidPoint={setToast}
                mapEditMode={editingMap ? brushMode : null}
                brushSize={brushSize}
                onPaintCell={paintMapCell}
                zoom={zoom}
                onZoom={setZoom}
              />
            ) : (
              <Scene3D
                world={world}
                result={result}
                start={start3}
                goal={goal3}
                playhead={playhead}
                showExpanded={showExpanded}
                showPath={showPath}
                pickMode={editMode}
                onPick={(which, point) => {
                  const snapped = snapEndpoint(world, point)
                  if (which === 'start') setStart3(snapped)
                  else setGoal3(snapped)
                  setEditMode('none')
                }}
              />
            )}
            {!is3D && showGhost && ghostPath.length > 1 ? (
              <div className="canvas-legend">
                <span className="legend-dash" />
                {tr(lang, '上一版路径')}
              </div>
            ) : null}
          </div>

          {result.status === 'infeasible' && infeasibleDetail ? (
            <div className="metrics-strip infeasible-strip" role="status">
              <div className="infeasible-copy">
                <span className="infeasible-label">
                  <Icon name="alert" size={13} />
                  {tr(lang, '无可行路径')}
                </span>
                <strong>{infeasibleDetail.title}</strong>
                <span className="infeasible-hint">{infeasibleDetail.hint}</span>
              </div>
              <button
                type="button"
                className="infeasible-action"
                onClick={() => {
                  if (infeasibleDetail.card) selectCard(infeasibleDetail.card)
                  else setRightTab('recipe')
                }}
              >
                {infeasibleDetail.card ? tr(lang, '调整参数') : tr(lang, '调整配方')}
              </button>
            </div>
          ) : (
            <MetricsStrip
              scale={is3D ? 1 : activeMap.cellSize}
              result={result}
              pending={planState.pending}
              progress={planState.progress}
              onOpen={() => setRightTab('metrics')}
            />
          )}
        </section>

        {rightCollapsed ? (
          <button
            type="button"
            className="pane-tab pane-tab-right"
            title={tr(lang, '展开配方栏')}
            onClick={() => setRightCollapsed(false)}
          >
            <Icon name="chevronDown" size={13} />
          </button>
        ) : (
        <aside className={`recipe-dock ${resizing ? 'is-resizing' : ''}`}>
          <div
            className="dock-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={tr(lang, '调整配方面板宽度')}
            title={tr(lang, '拖动调整右栏宽度')}
            onPointerDown={beginResize}
          />

          <div className="dock-head">
            <div>
              <h2>
                {rightTab === 'recipe'
                  ? tr(lang, '装配表')
                  : rightTab === 'card'
                    ? tr(lang, '参数详情')
                    : rightTab === 'metrics'
                      ? tr(lang, '指标')
                      : rightTab === 'flow'
                        ? tr(lang, '执行流程')
                        : tr(lang, '运行记录')}
              </h2>
            </div>
            <div className="dock-head-actions">
              {rightTab === 'recipe' ? (
                <span className="count-badge">{recipeOrder.length} {tr(lang, '项')}</span>
              ) : null}
              <button
                type="button"
                className="dock-collapse"
                title={tr(lang, '收起配方栏')}
                aria-label={tr(lang, '收起配方栏')}
                onClick={() => setRightCollapsed(true)}
              >
                <Icon name="chevronDown" size={13} />
              </button>
            </div>
          </div>

          <div className="inspector-tabs" role="tablist" aria-label={lang === 'en' ? 'Assembly and inspector' : '配方与检查器'}>
            <button
              type="button"
              className={rightTab === 'recipe' ? 'is-active' : ''}
              onClick={() => setRightTab('recipe')}
            >
              {tr(lang, '装配')}
            </button>
            <button
              type="button"
              className={rightTab === 'card' ? 'is-active' : ''}
              onClick={() => setRightTab('card')}
            >
              {tr(lang, '参数')}
            </button>
            <button
              type="button"
              className={rightTab === 'metrics' ? 'is-active' : ''}
              onClick={() => setRightTab('metrics')}
            >
              {tr(lang, '指标')}
            </button>
            <button
              type="button"
              className={rightTab === 'flow' ? 'is-active' : ''}
              onClick={() => setRightTab('flow')}
            >
              {tr(lang, '流程')}
            </button>
            <button
              type="button"
              className={rightTab === 'run' ? 'is-active' : ''}
              onClick={() => setRightTab('run')}
            >
              {tr(lang, '运行')}
            </button>
          </div>

          {rightTab === 'recipe' ? (
            <div className="recipe-dock-body">
              <div
                className={`recipe-list ${draggedCard ? 'is-dragging' : ''}`}
                onDragOver={handleRecipeDragOver}
                onDrop={(event) => {
                  event.preventDefault()
                  dragDroppedRef.current = true
                  document.body.classList.remove('is-dragging-card')
                  draggedCardRef.current = null
                  setDraggedCard(null)
                  setDragOverCard(null)
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                    setDragOverCard(null)
                  }
                }}
              >
                {recipeOrder.length === 0 ? (
                  <div className="panel-empty">
                    <span className="empty-icon">
                      <Icon name="layers" size={18} />
                    </span>
                    <strong>{tr(lang, '装配还是空的')}</strong>
                    <p>{tr(lang, '从左侧组件库点选加入，在这里拖动排序。')}</p>
                  </div>
                ) : (
                  recipeOrder.map((id) => {
                    const def = CARD_BY_ID[id]
                    return (
                      <div
                        key={id}
                        ref={(node) => {
                          if (node) recipeSlotRefs.current.set(id, node)
                          else recipeSlotRefs.current.delete(id)
                        }}
                        className={`recipe-slot ${
                          draggedCard === id ? 'is-dragging' : ''
                        } ${dragOverCard === id ? 'is-drag-over' : ''}`}
                        onMouseEnter={() => setHoverCard(id)}
                        onMouseLeave={() => setHoverCard(null)}
                      >
                        <Card
                          def={def}
                          state={cards[id]}
                          selected={false}
                          index={recipeOrder.indexOf(id)}
                          inapplicable={!cardApplies(id, planState.solver)}
                          onSelect={() => selectCard(id)}
                          onToggle={() =>
                            updateCard(id, { enabled: !cards[id].enabled })
                          }
                          onValue={(value) =>
                            updateCard(id, {
                              value: clampCardValue(id, value),
                            })
                          }
                          onAdjustStart={() => {
                            beginGesture()
                          }}
                          onAdjustEnd={() => {
                            endGesture()
                          }}
                          draggable
                          dragging={draggedCard === id}
                          onDragStart={(event) => {
                            event.dataTransfer.setData('text/plain', id)
                            event.dataTransfer.effectAllowed = 'move'
                            const card = event.currentTarget.closest('.card')
                            if (card) event.dataTransfer.setDragImage(card, 22, 22)
                            draggedCardRef.current = id
                            dragDroppedRef.current = false
                            document.body.classList.add('is-dragging-card')
                            setDraggedCard(id)
                            setDragOverCard(null)
                          }}
                          onDragEnd={() => {
                            document.body.classList.remove('is-dragging-card')
                            if (!dragDroppedRef.current) {
                              setToast(tr(lang, '已取消排序：卡片拖出了装配区域'))
                            }
                            draggedCardRef.current = null
                            setDraggedCard(null)
                            setDragOverCard(null)
                          }}
                        />
                      </div>
                    )
                  })
                )}
              </div>

            </div>
          ) : null}

          {rightTab === 'card' ? (
            selectedCardId && selectedState ? (
              <CardInspector
                id={selectedCardId}
                state={selectedState}
                map={activeMap}
                cards={effectiveCards}
                order={recipeOrder}
                continuous={result.continuous}
                solver={planState.solver}
                onToggle={() =>
                  updateCard(selectedCardId, { enabled: !selectedState.enabled })
                }
                onAddCard={addToRecipe}
                onValue={(value) =>
                  updateCard(selectedCardId, {
                    value: clampCardValue(selectedCardId, value),
                  })
                }
                onAdjustStart={() => {
                  beginGesture()
                }}
                onAdjustEnd={() => {
                  endGesture()
                }}
              />
            ) : (
              <div className="panel-empty">
                <span className="empty-icon">
                  <Icon name="sliders" size={18} />
                </span>
                <strong>{tr(lang, '还没有选中卡片')}</strong>
                <p>{tr(lang, '在“装配”里点击一行，查看它编译成什么、影响画布上的什么。')}</p>
              </div>
            )
          ) : null}

          {rightTab === 'metrics' ? (
            <MetricsPanel
              map={activeMap}
              result={result}
              previous={previousMetrics}
              cards={effectiveCards}
              onSelectCard={selectCard}
              onQuickToggle={quickToggle}
            />
          ) : null}

          {rightTab === 'flow' ? (
            <FlowPanel
              cards={effectiveCards}
              order={recipeOrder}
              result={result}
              map={activeMap}
              playhead={playhead}
              playing={playing}
              algorithm={localizeAlgorithm(lang, result.algorithmLabel)}
              focusCard={hoverCard ?? selectedCardId}
              onReorder={moveRecipeCard}
              onSelectCard={selectCard}
              onHoverStart={setHoverCard}
              onHoverEnd={() => setHoverCard(null)}
            />
          ) : null}

          {rightTab === 'run' ? (
            <RunPanel
              map={activeMap}
              cards={effectiveCards}
              result={result}
              formula={formula}
              onReplay={replay}
              onExportJson={exportJson}
              onExportCsv={exportCsv}
              onReset={handleReset}
            />
          ) : null}
        </aside>
        )}
      </main>

      {bottomCollapsed ? (
        <button
          type="button"
          className="pane-tab pane-tab-bottom"
          title={tr(lang, '展开播放栏')}
          onClick={() => setBottomCollapsed(false)}
        >
          <Icon name="chevronDown" size={12} />
        </button>
      ) : (
        <div className="timeline-wrap">
          <div
            className="pane-resizer timeline-resizer"
            role="separator"
            aria-orientation="horizontal"
            title={tr(lang, '拖动调整播放栏高度')}
            onPointerDown={beginBottomResize}
          />
          <Timeline
            result={result}
            playhead={playhead}
            playing={playing}
            speed={speed}
            onPlayhead={setPlayhead}
            onPlaying={setPlaying}
            onSpeed={setSpeed}
          />
        </div>
      )}


      {toast ? (
        <div className="toast" role="status">
          <Icon name="check" size={14} />
          {toast}
        </div>
      ) : null}
    </div>
    </LangContext.Provider>
  )
}
