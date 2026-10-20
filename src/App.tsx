import {
  Fragment,
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
import { Icon } from './components/Icon'
import {
  CARD_BY_ID,
  CARD_DEFS,
  CARD_GROUPS,
  cardValueLabel,
  createDefaultCards,
  createDefaultRecipeOrder,
  type CardDef,
} from './lib/cards'
import { getMap, mapFromCells, MAPS } from './lib/maps'
import { plan } from './lib/planner'
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
const VERSION = '0.1.0'

function clampCardValue(id: CardId, value: number): number {
  const def = CARD_BY_ID[id]
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
  mapId: MapId
  cards: CardsState
  order: CardId[]
  start: Point
  goal: Point
  cells: Uint8Array | null
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
      x?: string
    }
    const mapId = payload.m as MapId
    if (!MAPS.some((map) => map.id === mapId)) return null
    const baseMap = getMap(mapId)
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
    const readPoint = (entry: number[] | undefined, fallback: Point): Point => {
      if (!Array.isArray(entry) || entry.length < 2) return { ...fallback }
      const x = Math.round(Number(entry[0]))
      const y = Math.round(Number(entry[1]))
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= baseMap.width ||
        y >= baseMap.height ||
        baseMap.cells[y * baseMap.width + x] === 1
      ) {
        return { ...fallback }
      }
      return { x, y }
    }
    let start = readPoint(payload.s, baseMap.start)
    let goal = readPoint(payload.g, baseMap.goal)
    if (start.x === goal.x && start.y === goal.y) {
      start = { ...baseMap.start }
      goal = { ...baseMap.goal }
    }
    const cells =
      typeof payload.x === 'string'
        ? decodeCells(payload.x, baseMap.width * baseMap.height)
        : null
    return { mapId, cards, order, start, goal, cells }
  } catch {
    return null
  }
}

const INITIAL_RECIPE = readRecipeFromUrl()

function serializeRecipe(
  mapId: MapId,
  cards: CardsState,
  order: CardId[],
  start: Point,
  goal: Point,
  cells: Uint8Array | null,
): string {
  const compact = {
    m: mapId,
    o: order,
    s: [start.x, start.y],
    g: [goal.x, goal.y],
    x: cells ? encodeCells(cells) : undefined,
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

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Math.round(value))
}

function compileFormula(cards: CardsState, order: CardId[]): string {
  const modeIndex = cards.strategy.enabled ? Math.round(cards.strategy.value) : 0
  const modeLabel = CARD_BY_ID.strategy.options?.[modeIndex] ?? 'A*'
  const ignoreHeuristic = modeIndex === 1 || modeIndex === 3 || modeIndex === 4
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
    if (id === 'clearance') terms.push(`${state.value.toFixed(2)}·c`)
    if (id === 'turn') terms.push(`${state.value.toFixed(2)}·t`)
    if (id === 'diagonalBias') terms.push(`${state.value.toFixed(2)}·o`)
    if (id === 'collision') {
      constraints.push(`s.t. d ≥ ${state.value.toFixed(2)}`)
    }
    if (id === 'goalTolerance') {
      constraints.push(`s.t. ||n-g|| ≤ ${state.value.toFixed(2)}`)
    }
    if (id === 'cornerCut') constraints.push('geom · 允许切角')
    if (id === 'budget') {
      constraints.push(`s.t. expanded ≤ ${Math.round(state.value)}`)
    }
    if (id === 'noUTurn') constraints.push('s.t. Δθ ≠ 180°')
    if (id === 'maxTurn') {
      constraints.push(`s.t. Δθ ≤ ${state.value.toFixed(0)}°`)
    }
    if (id === 'smooth') bridges.push('拉直')
    if (id === 'round') bridges.push('圆角')
    if (id === 'simplify') bridges.push('抽稀')
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
): { title: string; hint: string; card: CardId | null } {
  if (
    cards.budget.enabled &&
    result.expanded >= Math.floor(cards.budget.value)
  ) {
    return {
      title: '扩展预算耗尽',
      hint: `本轮扩展了 ${formatNumber(result.expanded)} 个节点，达到预算上限。提高「扩展预算」，或换更直接的策略。`,
      card: 'budget',
    }
  }
  if (cards.maxTurn.enabled) {
    return {
      title: '最大转角约束过严',
      hint: '当前路径需要更大的转向角。把「最大转角」放宽到 90° 或 135°，或暂时停用该约束。',
      card: 'maxTurn',
    }
  }
  if (cards.noUTurn.enabled) {
    return {
      title: '反向剪枝切断了通道',
      hint: '关闭「反向剪枝」再试；在窄走廊里禁止 180° 反向可能会把唯一通路剪掉。',
      card: 'noUTurn',
    }
  }
  if (cards.collision.enabled) {
    return {
      title: '安全膨胀半径过大',
      hint: '障碍膨胀后通道被堵死。调小「安全膨胀」半径，或关闭硬约束观察原始路径。',
      card: 'collision',
    }
  }
  return {
    title: '起点或终点被围住',
    hint: '拖动 S / G 到更开阔的位置，或用「编辑」清掉端点附近的障碍。',
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
  const lengthM = result.pathLength * map.cellSize
  const clearanceM = result.minClearance * map.cellSize
  const total = result.totalCost
  const costItems: Array<{ id: string; label: string; value: number; color: string; card?: CardId }> = [
    { id: 'length', label: '长度', value: result.cost.length, color: '#1f4e5f' },
    {
      id: 'clearance',
      label: '间隙',
      value: result.cost.clearance,
      color: '#8a6a2f',
      card: 'clearance',
    },
    {
      id: 'turn',
      label: '转弯',
      value: result.cost.turn,
      color: '#8f5540',
      card: 'turn',
    },
    ...(cards.diagonalBias.enabled
      ? [
          {
            id: 'bias',
            label: '斜线',
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
          <strong>{result.status === 'success' ? '已收敛' : '无可行路径'}</strong>
        </div>
        <span className="run-time">{result.solveTime.toFixed(1)} ms</span>
      </div>

      <div className="hero-metric">
        <span className="metric-label">路径长度</span>
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
          {result.algorithmLabel} · {cards.diagonal.enabled ? '8 邻域' : '4 邻域'} ·{' '}
          {result.waypoints} 个路径点
        </p>
      </div>

      <div className="stat-row">
        <div className="stat">
          <span className="stat-label">扩展节点</span>
          <strong key={`exp-${result.expanded}`} className="value-anim">
            {formatNumber(result.expanded)}
          </strong>
          <Delta
            current={result.expanded}
            previous={previous?.expanded ?? null}
            digits={0}
          />
        </div>
        <div className="stat">
          <span className="stat-label">最小间隙</span>
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
          <span className="stat-label">求解时间</span>
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

      <SectionLabel action={<span className="section-note">对比上次运行</span>}>
        代价构成
      </SectionLabel>
      <div className="cost-card">
        <div
          className="cost-donut"
          style={{ background: donutBackground }}
          aria-label={`总代价 ${total.toFixed(1)}`}
        >
          <div className="cost-donut-center">
            <strong>{total.toFixed(1)}</strong>
            <span>cost</span>
          </div>
        </div>
        <div className="cost-main">
          <div className="cost-total">
            <span>总代价</span>
            <strong>{total.toFixed(1)}</strong>
          </div>
          <div className="cost-bar" aria-label="代价构成">
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
        <SectionLabel>试一试</SectionLabel>
        <div className="quick-actions">
          <button
            type="button"
            className="quick-action"
            onClick={() => onQuickToggle('heuristic')}
          >
            <span className="quick-icon quick-icon-violet">
              <Icon name="compass" size={14} />
            </span>
            <span className="quick-copy">
              <strong>
                {cards.heuristic.enabled ? '关掉「启发式引导」' : '打开「启发式引导」'}
              </strong>
              <em>
                {cards.heuristic.enabled
                  ? '看搜索从一束光变成均匀水波'
                  : '看搜索重新聚焦到终点'}
              </em>
            </span>
            <Icon name="stepForward" size={12} className="quick-arrow" />
          </button>
          <button
            type="button"
            className="quick-action"
            onClick={() => onQuickToggle('smooth')}
          >
            <span className="quick-icon quick-icon-teal">
              <Icon name="smooth" size={14} />
            </span>
            <span className="quick-copy">
              <strong>
                {cards.smooth.enabled ? '关掉「可见性剪枝」' : '打开「可见性剪枝」'}
              </strong>
              <em>
                {cards.smooth.enabled
                  ? '回到原始折线，对比桥接前后'
                  : '看折线怎么被拉直、路径点怎么变少'}
              </em>
            </span>
            <Icon name="stepForward" size={12} className="quick-arrow" />
          </button>
        </div>
      </div>

      <p className="metric-footnote">指标来自本轮实际路径，不是视觉估算。</p>
    </div>
  )
}

function CardInspector({
  id,
  state,
  onToggle,
  onValue,
  onAdjustStart,
  onAdjustEnd,
}: {
  id: CardId
  state: { enabled: boolean; value: number }
  onToggle: () => void
  onValue: (value: number) => void
  onAdjustStart: () => void
  onAdjustEnd: () => void
}) {
  const def = CARD_BY_ID[id]
  const group = CARD_GROUPS.find((item) => item.id === def.group)
  const hasSlider = def.kind !== 'toggle'
  const min = def.min ?? 0
  const max = def.max ?? 1
  const fill = max > min ? ((state.value - min) / (max - min)) * 100 : 0
  return (
    <div className="panel-scroll panel-content">
      <div className="card-detail-head">
        <span
          className="card-detail-icon"
          style={{ '--card-accent': def.accent } as CSSProperties}
        >
          <Icon name={def.icon} size={18} />
        </span>
        <div>
          <span className="eyebrow">{group?.label}</span>
          <h2>{def.title}</h2>
        </div>
        <button
          className={`switch ${state.enabled ? 'is-on' : ''}`}
          type="button"
          role="switch"
          aria-checked={state.enabled}
          aria-label={`${state.enabled ? '停用' : '启用'}${def.title}`}
          onClick={onToggle}
        >
          <span className="switch-thumb" />
        </button>
      </div>

      <p className="card-detail-text">{def.detail}</p>

      <SectionLabel>在图搜索中编译为</SectionLabel>
      <pre className="formula-block">{def.formula}</pre>
      <div className="compile-row">
        <span>优先级 / 代价</span>
        <strong>{def.compiles}</strong>
      </div>
      <div className="compile-row">
        <span>视觉映射</span>
        <strong>{def.visual}</strong>
      </div>

      {def.kind === 'choice' ? (
        <>
          <SectionLabel
            action={<span className="section-note">{cardValueLabel(def, state.value)}</span>}
          >
            策略
          </SectionLabel>
          <div className="choice-row inspector-choice">
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
                {option}
              </button>
            ))}
          </div>
        </>
      ) : hasSlider ? (
        <>
          <SectionLabel
            action={<span className="section-note">{cardValueLabel(def, state.value)}</span>}
          >
            {def.id === 'goalTolerance'
              ? '容差半径'
              : def.id === 'budget'
                ? '扩展上限'
                : def.kind === 'radius'
                  ? '安全半径'
                  : def.kind === 'angle'
                    ? '最大转角'
                    : '权重'}
          </SectionLabel>
          <input
            className="range range-inspector"
            type="range"
            min={def.min ?? 0}
            max={def.max ?? 1}
            step={def.step ?? 0.05}
            value={state.value}
            disabled={!state.enabled}
            aria-label={`${def.title}参数`}
            style={
              {
                '--fill': `${fill}%`,
                '--range-color': def.accent,
              } as CSSProperties
            }
            onChange={(event) => onValue(Number(event.target.value))}
            onPointerDown={onAdjustStart}
            onPointerUp={onAdjustEnd}
            onPointerCancel={onAdjustEnd}
            onBlur={onAdjustEnd}
          />
          <div className="range-scale">
            <span>
              {def.kind === 'angle' || def.kind === 'budget'
                ? (def.min ?? 0).toFixed(0)
                : (def.min ?? 0).toFixed(2)}
            </span>
            <span>
              {def.kind === 'angle' || def.kind === 'budget'
                ? (def.max ?? 1).toFixed(0)
                : (def.max ?? 1).toFixed(2)}
            </span>
          </div>
        </>
      ) : (
        <div className="toggle-note">
          <span>{state.enabled ? '正在参与编译' : '已停用，不影响结果'}</span>
          <strong>{state.enabled ? '开' : '关'}</strong>
        </div>
      )}

      {def.kind !== 'toggle' ? (
        <p className="param-hint">
          无解时滑杆不会锁死；可行区间可能不连续，可以继续拖到另一段可行值。
        </p>
      ) : null}

      <div className="inspector-hint">
        <Icon name="info" size={14} />
        悬停这张卡时，画布会亮起它影响的场或路径区域。
      </div>
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
  return (
    <div className="panel-scroll panel-content">
      <SectionLabel>本轮结果</SectionLabel>
      <div className="definition-list">
        <div>
          <span>算法</span>
          <strong>{result.algorithmLabel}</strong>
        </div>
        <div>
          <span>路径点</span>
          <strong>{result.waypoints}</strong>
        </div>
        <div>
          <span>扩展 / 覆盖</span>
          <strong>
            {formatNumber(result.expanded)} / {formatNumber(result.expandedCells)}
          </strong>
        </div>
        <div>
          <span>结束开放集</span>
          <strong>{formatNumber(result.openAtEnd)}</strong>
        </div>
      </div>

      <SectionLabel>编译结果</SectionLabel>
      <pre className="formula-block formula-block-run">{formula}</pre>

      <SectionLabel>运行设置</SectionLabel>
      <div className="definition-list">
        <div>
          <span>场景</span>
          <strong>{map.name}</strong>
        </div>
        <div>
          <span>栅格</span>
          <strong>
            {map.width} × {map.height} · {map.cellSize.toFixed(1)} m / 格
          </strong>
        </div>
        <div>
          <span>邻域</span>
          <strong>{cards.diagonal.enabled ? '8 邻域，禁止穿角' : '4 邻域'}</strong>
        </div>
        <div>
          <span>启发式</span>
          <strong>
            {cards.heuristic.enabled ? `${cards.heuristic.value.toFixed(2)}×` : '关闭'}
          </strong>
        </div>
        <div>
          <span>安全半径</span>
          <strong>
            {cards.collision.enabled ? `${cards.collision.value.toFixed(2)} 格` : '关闭'}
          </strong>
        </div>
        <div>
          <span>确定性</span>
          <strong>固定顺序 · seed 0</strong>
        </div>
      </div>

      <SectionLabel>重播与导出</SectionLabel>
      <div className="run-actions">
        <button type="button" className="btn btn-secondary btn-wide" onClick={onReplay}>
          <Icon name="play" size={14} />
          重新播放搜索
        </button>
        <button type="button" className="btn btn-secondary btn-wide" onClick={onExportJson}>
          <Icon name="download" size={14} />
          导出配方 + 指标 JSON
        </button>
        <button type="button" className="btn btn-secondary btn-wide" onClick={onExportCsv}>
          <Icon name="download" size={14} />
          导出指标 CSV
        </button>
        <button type="button" className="btn btn-ghost btn-wide" onClick={onReset}>
          <Icon name="reset" size={14} />
          恢复默认配方
        </button>
      </div>

      <SectionLabel>模型边界</SectionLabel>
      <div className="model-note">
        <p>
          当前是 2D 栅格、点机器人、无动力学模型。路径长度和间隙按 {map.cellSize.toFixed(1)} m /
          格换算；速度、加速度等动力学指标尚未加入。
        </p>
        <p>
          这不是 EGO-Planner 的数值复现。它先把“搜索 + 代价 + 硬约束 + 桥接”的编译链跑通，
          下一步才接梯度优化骨架。
        </p>
      </div>

      <div className="trust-note">
        <Icon name="check" size={14} />
        同一场景 + 同一配方 + 同一 seed，结果可复现。
      </div>
    </div>
  )
}

function MetricsStrip({
  map,
  result,
  onOpen,
}: {
  map: GridMap
  result: PlanResult
  onOpen: () => void
}) {
  const solved = result.status === 'success'
  const lengthM = result.pathLength * map.cellSize
  const clearanceM = result.minClearance * map.cellSize
  return (
    <div className="metrics-strip">
      <div className="strip-metric is-primary">
        <span>路径长度</span>
        <strong>
          {solved ? lengthM.toFixed(2) : '—'}
          {solved ? <em>m</em> : null}
        </strong>
      </div>
      <div className="strip-metric">
        <span>扩展节点</span>
        <strong>{formatNumber(result.expanded)}</strong>
      </div>
      <div className="strip-metric">
        <span>最小间隙</span>
        <strong>
          {solved ? clearanceM.toFixed(2) : '—'}
          {solved ? <em>m</em> : null}
        </strong>
      </div>
      <div className="strip-metric">
        <span>求解时间</span>
        <strong>
          {result.solveTime.toFixed(1)}
          <em>ms</em>
        </strong>
      </div>
      <button type="button" className="strip-detail" onClick={onOpen}>
        查看指标
        <Icon name="chevronDown" size={13} />
      </button>
    </div>
  )
}

function LibraryItem({
  def,
  inRecipe,
  onToggle,
  onHoverStart,
  onHoverEnd,
}: {
  def: CardDef
  inRecipe: boolean
  onToggle: () => void
  onHoverStart: () => void
  onHoverEnd: () => void
}) {
  return (
    <button
      type="button"
      className={`library-item ${inRecipe ? 'is-in' : ''}`}
      style={{ '--card-accent': def.accent } as CSSProperties}
      onClick={onToggle}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      title={`${def.title}：${def.subtitle}（点击${inRecipe ? '移除' : '加入'}）`}
    >
      <span className="library-icon">
        <Icon name={def.icon} size={14} />
      </span>
      <span className="library-copy">
        <strong>{def.title}</strong>
        <em>{def.subtitle}</em>
      </span>
      <span className="library-action">
        <Icon name={inRecipe ? 'check' : 'plus'} size={12} />
      </span>
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
  const max = Math.max(1, result.events.length)
  const current = Math.min(playhead, result.events.length)
  const atEnd = current >= result.events.length
  const status =
    result.status === 'infeasible'
      ? '不可行'
      : playing
        ? '回放中'
        : atEnd
          ? '已收敛 · 暂停'
          : '已暂停'

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
          aria-label={playing ? '暂停' : '播放'}
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
          aria-label="搜索回放进度"
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
          {current} / {result.events.length} 格
        </span>
      </div>

      <div className="speed-control">
        <span>速度</span>
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

function FlowPanel({
  cards,
  order,
  algorithm,
  onReorder,
  onSelectCard,
  onHoverStart,
  onHoverEnd,
}: {
  cards: CardsState
  order: CardId[]
  algorithm: string
  onReorder: (id: CardId, index: number) => void
  onSelectCard: (id: CardId) => void
  onHoverStart: (id: CardId) => void
  onHoverEnd: () => void
}) {
  const [dragId, setDragId] = useState<CardId | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const flowNodeRefs = useRef<Map<CardId, HTMLDivElement>>(new Map())
  const flowTopsRef = useRef<Map<CardId, number> | null>(null)
  const flowDraggedRef = useRef(false)

  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const previous = flowTopsRef.current
    const next = new Map<CardId, number>()
    flowNodeRefs.current.forEach((element, id) => {
      next.set(id, element.getBoundingClientRect().top)
      const oldTop = previous?.get(id)
      if (oldTop === undefined) return
      const delta = oldTop - next.get(id)!
      if (Math.abs(delta) < 1) return
      element.getAnimations().forEach((animation) => animation.cancel())
      element.animate(
        [
          { transform: `translateY(${delta}px)` },
          { transform: 'translateY(0)' },
        ],
        {
          duration: 280,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        },
      )
    })
    flowTopsRef.current = next
  }, [order])

  function finishDrag() {
    document.body.classList.remove('is-dragging-card')
    setDragId(null)
    setOverIndex(null)
  }

  return (
    <div className="panel-scroll panel-content flow-panel">
      <div className="flow-head">
        <span className="flow-kicker">编译链</span>
        <h3>{algorithm}</h3>
        <p>拖动节点调整卡片顺序；搜索器按这条链读取代价、约束与后处理。</p>
      </div>

      <div className="flow-diagram">
        <div className="flow-node is-fixed">
          <span className="flow-index">IN</span>
          <span className="flow-node-copy">
            <span className="flow-cat">输入</span>
            <strong>地图 · 起点 / 终点</strong>
          </span>
        </div>
        <div className="flow-link" />

        {order.map((id, index) => {
          const def = CARD_BY_ID[id]
          const state = cards[id]
          const group = CARD_GROUPS.find((entry) => entry.id === def.group)
          return (
            <Fragment key={id}>
              {overIndex === index ? <div className="flow-drop" /> : null}
              <div
                className={`flow-node ${state.enabled ? '' : 'is-off'} ${
                  dragId === id ? 'is-dragging' : ''
                }`}
                ref={(node) => {
                  if (node) flowNodeRefs.current.set(id, node)
                  else flowNodeRefs.current.delete(id)
                }}
                style={{ '--flow-accent': def.accent } as CSSProperties}
                draggable
                onClick={() => {
                  if (flowDraggedRef.current) {
                    flowDraggedRef.current = false
                    return
                  }
                  onSelectCard(id)
                }}
                onMouseEnter={() => onHoverStart(id)}
                onMouseLeave={onHoverEnd}
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', id)
                  event.dataTransfer.effectAllowed = 'move'
                  document.body.classList.add('is-dragging-card')
                  flowDraggedRef.current = true
                  setDragId(id)
                }}
                onDragEnd={() => {
                  finishDrag()
                  window.setTimeout(() => {
                    flowDraggedRef.current = false
                  }, 120)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  setOverIndex(
                    event.clientY > rect.top + rect.height / 2
                      ? index + 1
                      : index,
                  )
                  const panel = event.currentTarget.closest('.flow-panel')
                  if (panel) {
                    const panelRect = panel.getBoundingClientRect()
                    if (event.clientY < panelRect.top + 36) panel.scrollTop -= 12
                    else if (event.clientY > panelRect.bottom - 36) {
                      panel.scrollTop += 12
                    }
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragId) onReorder(dragId, overIndex ?? index)
                  finishDrag()
                }}
              >
                <span className="flow-index">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="flow-node-icon">
                  <Icon name={def.icon} size={15} />
                </span>
                <span className="flow-node-copy">
                  <span className="flow-cat">{group?.label}</span>
                  <strong>{def.title}</strong>
                </span>
                <span className="flow-value">
                  {state.enabled ? cardValueLabel(def, state.value) : '停用'}
                </span>
                <span className="flow-grip" aria-hidden="true">
                  <Icon name="grip" size={12} />
                </span>
              </div>
              <div className="flow-link" />
            </Fragment>
          )
        })}

        {overIndex === order.length ? <div className="flow-drop" /> : null}
        <div className="flow-node is-fixed is-output">
          <span className="flow-index">OUT</span>
          <span className="flow-node-copy">
            <span className="flow-cat">输出</span>
            <strong>路径 · 指标 · 对比</strong>
          </span>
        </div>
      </div>

      <p className="flow-hint">
        拖动节点会同步重排右侧配方；点击节点可直接查看该卡参数。
      </p>
    </div>
  )
}

export default function App() {
  const [mapId, setMapId] = useState<MapId>(INITIAL_RECIPE?.mapId ?? DEFAULT_MAP_ID)
  const [cards, setCards] = useState<CardsState>(
    () => INITIAL_RECIPE?.cards ?? createDefaultCards(),
  )
  const [selectedCardId, setSelectedCardId] = useState<CardId | null>(null)
  const [hoverCard, setHoverCard] = useState<CardId | null>(null)
  const [rightTab, setRightTab] = useState<RightTab>('recipe')
  const [recipeOrder, setRecipeOrder] = useState<CardId[]>(
    () => INITIAL_RECIPE?.order ?? createDefaultRecipeOrder(),
  )
  const [recipeWidth, setRecipeWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('pathcraft:recipe-width:v3'))
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
  const [isAdjusting, setIsAdjusting] = useState(false)
  const [ghostPath, setGhostPath] = useState<Point[]>([])
  const [previousMetrics, setPreviousMetrics] = useState<MetricSnapshot | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [editedCells, setEditedCells] = useState<Uint8Array | null>(
    () => INITIAL_RECIPE?.cells ?? null,
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
    () => (editedCells ? mapFromCells(baseMap, editedCells) : baseMap),
    [baseMap, editedCells],
  )
  const isCustomMap = editedCells !== null
  const [start, setStart] = useState<Point>(
    () => INITIAL_RECIPE?.start ?? { ...map.start },
  )
  const [goal, setGoal] = useState<Point>(
    () => INITIAL_RECIPE?.goal ?? { ...map.goal },
  )
  const [editMode, setEditMode] = useState<'none' | 'start' | 'goal'>('none')
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
  const result = useMemo(
    () => plan(activeMap, effectiveCards, recipeOrder),
    [activeMap, effectiveCards, recipeOrder],
  )
  const previousRunRef = useRef<{ result: PlanResult; mapId: MapId } | null>(null)

  useEffect(() => {
    const previous = previousRunRef.current
    if (previous && previous.result !== result && previous.mapId === mapId) {
      setGhostPath(previous.result.path)
      setPreviousMetrics(metricSnapshot(previous.result, activeMap))
    }
    previousRunRef.current = { result, mapId }
  }, [result, activeMap, mapId])

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
    const duration = Math.max(240, 900 / speed)
    const startedAt = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 2.2)
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
    const hash = `#r=${serializeRecipe(mapId, cards, recipeOrder, start, goal, editedCells)}`
    window.history.replaceState(null, '', hash)
  }, [mapId, cards, recipeOrder, start, goal, editedCells])

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
      window.localStorage.setItem('pathcraft:recipe-width:v3', String(recipeWidth))
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
    effectiveCards.smooth.enabled || effectiveCards.round.enabled
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
          if (x <= 0 || y <= 0 || x >= baseMap.width - 1 || y >= baseMap.height - 1) {
            continue
          }
          if (
            (x === start.x && y === start.y) ||
            (x === goal.x && y === goal.y)
          ) {
            continue
          }
          next[y * baseMap.width + x] = brushMode === 'wall' ? 1 : 0
        }
      }
      return next
    })
  }

  function clearMap() {
    const cells = new Uint8Array(baseMap.cells.length)
    for (let x = 0; x < baseMap.width; x += 1) {
      cells[x] = 1
      cells[(baseMap.height - 1) * baseMap.width + x] = 1
    }
    for (let y = 0; y < baseMap.height; y += 1) {
      cells[y * baseMap.width] = 1
      cells[y * baseMap.width + baseMap.width - 1] = 1
    }
    cells[start.y * baseMap.width + start.x] = 0
    cells[goal.y * baseMap.width + goal.x] = 0
    setEditedCells(cells)
  }

  function restorePresetMap() {
    setEditedCells(null)
    setStart({ ...baseMap.start })
    setGoal({ ...baseMap.goal })
    setEditingMap(false)
    setEditMode('none')
  }

  function handleMapChange(nextMapId: MapId) {
    const nextMap = getMap(nextMapId)
    setMapId(nextMapId)
    setEditedCells(null)
    setEditingMap(false)
    setStart({ ...nextMap.start })
    setGoal({ ...nextMap.goal })
    setEditMode('none')
    setGhostPath([])
    setPreviousMetrics(null)
    setPlayhead(0)
    setReplayNonce((value) => value + 1)
  }

  function handleReset() {
    const resetMap = getMap(DEFAULT_MAP_ID)
    setCards(createDefaultCards())
    setMapId(DEFAULT_MAP_ID)
    setEditedCells(null)
    setEditingMap(false)
    setStart({ ...resetMap.start })
    setGoal({ ...resetMap.goal })
    setEditMode('none')
    setRecipeOrder(createDefaultRecipeOrder())
    setSelectedCardId(null)
    setRightTab('recipe')
    setGhostPath([])
    setPreviousMetrics(null)
    setPlayhead(0)
    setReplayNonce((value) => value + 1)
    setToast('已恢复默认配方')
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
        algorithm: result.algorithmLabel,
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
    setToast('配方 JSON 已导出')
  }

  function exportCsv() {
    const rows: Array<Array<string | number>> = [
      ['metric', 'value', 'unit'],
      ['map', map.name, ''],
      ['start', `${start.x},${start.y}`, 'cell'],
      ['goal', `${goal.x},${goal.y}`, 'cell'],
      ['algorithm', result.algorithmLabel, ''],
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
    setToast('指标 CSV 已导出')
  }

  async function share() {
    const url = window.location.href
    try {
      await navigator.clipboard.writeText(url)
      setToast('分享链接已复制')
    } catch {
      setToast('复制失败，请手动复制地址栏')
    }
  }

  return (
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
          <span className="brand-mark">
            <Icon name="logo" size={23} />
          </span>
          <div className="brand-text">
            <strong>Pathcraft</strong>
            <span>路径算法拼装台</span>
          </div>
        </div>

        <div className="topbar-center">
          <div className="scenario-switch" role="group" aria-label="选择场景">
            {MAPS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={mapId === item.id ? 'is-active' : ''}
                onClick={() => handleMapChange(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <span className="topbar-divider" />
          <span className="stage-pill">
            <span className="stage-dot" />
            {stageLabel}
          </span>
        </div>

        <div className="topbar-actions">
          <button type="button" className="btn btn-ghost" onClick={handleReset}>
            <Icon name="reset" size={14} />
            重置
          </button>
          <button type="button" className="btn btn-ghost" onClick={exportJson}>
            <Icon name="download" size={14} />
            导出
          </button>
          <button type="button" className="btn btn-primary" onClick={share}>
            <Icon name="share" size={14} />
            分享
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
              <h1>卡片库</h1>
              <p className="panel-sub">{CARD_DEFS.length} 张 · 点击加入</p>
            </div>
            <div className="panel-head-actions">

              <button
                type="button"
                className="panel-collapse"
                title="收起卡片库"
                aria-label="收起卡片库"
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
                    <span>{group.label}</span>
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


          <div
            className="pane-resizer library-resizer"
            role="separator"
            aria-orientation="vertical"
            title="拖动调整卡片库宽度"
            onPointerDown={beginLeftResize}
          />
        </aside>
        )}

        <section className="stage">
          <div className="stage-head">
            <div className="stage-title">
              <h2>
                {map.name}
                {isCustomMap ? <span className="custom-map-badge">已编辑</span> : null}
              </h2>
              <p>{map.description}</p>
            </div>
            <div className="stage-actions">
              <span className="stage-algorithm">{result.algorithmLabel}</span>
              <span className={result.status === 'success' ? 'is-ok' : 'is-bad'}>
                <span
                  className={`status-dot ${
                    result.status === 'success' ? 'is-ok' : 'is-bad'
                  }`}
                />
                {result.status === 'success' ? '可行' : '不可行'}
              </span>
            </div>
          </div>

          <div className="canvas-toolbar">
            <div className="layer-switch" role="group" aria-label="图层显示">
              <button
                type="button"
                className={`layer-btn ${showExpanded ? 'is-on' : ''}`}
                aria-pressed={showExpanded}
                title={showExpanded ? '搜索点：显示中，点击隐藏' : '搜索点：已隐藏，点击显示'}
                onClick={() => setShowExpanded((value) => !value)}
              >
                <Icon name={showExpanded ? 'eye' : 'eyeOff'} size={12} />
                <span>搜索</span>
                <em>{showExpanded ? '开' : '关'}</em>
              </button>
              <button
                type="button"
                className={`layer-btn ${showPath ? 'is-on' : ''}`}
                aria-pressed={showPath}
                title={showPath ? '路径：显示中，点击隐藏' : '路径：已隐藏，点击显示'}
                onClick={() => setShowPath((value) => !value)}
              >
                <Icon name={showPath ? 'eye' : 'eyeOff'} size={12} />
                <span>路径</span>
                <em>{showPath ? '开' : '关'}</em>
              </button>
              <button
                type="button"
                className={`layer-btn ${showGhost ? 'is-on' : ''}`}
                aria-pressed={showGhost}
                title={showGhost ? '旧路径：显示中，点击隐藏' : '旧路径：已隐藏，点击显示上一版结果'}
                onClick={() => setShowGhost((value) => !value)}
              >
                <Icon name={showGhost ? 'eye' : 'eyeOff'} size={12} />
                <span>旧路径</span>
                <em>{showGhost ? '开' : '关'}</em>
              </button>
            </div>
            <div className="edit-points" role="group" aria-label="编辑起点终点">
              <button
                type="button"
                className={editMode === 'start' ? 'is-active' : ''}
                onClick={() => {
                  setEditingMap(false)
                  setEditMode(editMode === 'start' ? 'none' : 'start')
                }}
              >
                <Icon name="target" size={12} />
                起点
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
                终点
              </button>
            </div>
            <button
              type="button"
              className={`map-edit-toggle ${editingMap ? 'is-active' : ''}`}
              aria-pressed={editingMap}
              title={editingMap ? '退出地图编辑' : '编辑 2D 栅格地图'}
              onClick={() => {
                setEditingMap((value) => !value)
                setEditMode('none')
              }}
            >
              <Icon name="edit" size={12} />
              编辑
            </button>
            <button
              type="button"
              className={`map-edit-toggle focus-toggle ${
                leftCollapsed && rightCollapsed ? 'is-active' : ''
              }`}
              title={
                leftCollapsed && rightCollapsed
                  ? '退出专注画布'
                  : '收起两侧面板，专注画布'
              }
              onClick={() => {
                const focus = !(leftCollapsed && rightCollapsed)
                setLeftCollapsed(focus)
                setRightCollapsed(focus)
              }}
            >
              {leftCollapsed && rightCollapsed ? '退出专注' : '专注'}
            </button>
            <span className="canvas-toolbar-hint">
              {editingMap
                ? '编辑模式 · 在画布上拖动绘制，2D 栅格'
                : editMode === 'start'
                  ? '点击地图放置起点，或直接拖动 S'
                  : editMode === 'goal'
                    ? '点击地图放置终点，或直接拖动 G'
                    : ''}
            </span>
            <div className="zoom-control" role="group" aria-label="画布缩放">
              <button
                type="button"
                aria-label="缩小画布"
                onClick={() => setZoom((value) => Math.max(0.8, value - 0.05))}
              >
                −
              </button>
              <button
                type="button"
                className="zoom-value"
                title="重置缩放"
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                aria-label="放大画布"
                onClick={() => setZoom((value) => Math.min(1.05, value + 0.05))}
              >
                +
              </button>
            </div>
            <span className="canvas-toolbar-meta">{map.cellSize.toFixed(1)} m / 格</span>
          </div>

          {editingMap ? (
            <div className="edit-bar">
              <span className="edit-badge">2D 栅格</span>
              <div className="edit-modes">
                <button
                  type="button"
                  className={brushMode === 'wall' ? 'is-active' : ''}
                  onClick={() => setBrushMode('wall')}
                >
                  <Icon name="edit" size={12} />
                  画墙
                </button>
                <button
                  type="button"
                  className={brushMode === 'erase' ? 'is-active' : ''}
                  onClick={() => setBrushMode('erase')}
                >
                  <Icon name="eraser" size={12} />
                  擦除
                </button>
              </div>
              <div className="brush-sizes">
                <span>笔刷</span>
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
              <div className="edit-actions">
                <button type="button" onClick={clearMap}>
                  <Icon name="trash" size={12} />
                  清空
                </button>
                <button type="button" onClick={restorePresetMap}>
                  <Icon name="reset" size={12} />
                  恢复预设
                </button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => setEditingMap(false)}
                >
                  <Icon name="check" size={12} />
                  完成
                </button>
              </div>
            </div>
          ) : null}


          <div
            className={`canvas-area ${
              result.status === 'infeasible' ? 'is-infeasible' : ''
            }`}
          >
            <CanvasView
              map={activeMap}
              cards={effectiveCards}
              result={result}
              playhead={playhead}
              ghostPath={ghostPath}
              hoverCard={hoverCard}
              showExpanded={showExpanded}
              showPath={showPath}
              showGhost={showGhost}
              editMode={editMode}
              onStartChange={setStart}
              onGoalChange={setGoal}
              onPlacePoint={() => setEditMode('none')}
              onInvalidPoint={setToast}
              mapEditMode={editingMap ? brushMode : null}
              brushSize={brushSize}
              onPaintCell={paintMapCell}
              zoom={zoom}
              onZoom={setZoom}
            />
            {showGhost && ghostPath.length > 1 ? (
              <div className="canvas-legend">
                <span className="legend-dash" />
                上一版路径
              </div>
            ) : null}
          </div>

          {result.status === 'infeasible' && infeasibleDetail ? (
            <div className="metrics-strip infeasible-strip" role="status">
              <div className="infeasible-copy">
                <span className="infeasible-label">
                  <Icon name="alert" size={13} />
                  无可行路径
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
                {infeasibleDetail.card ? '调整参数' : '调整配方'}
              </button>
            </div>
          ) : (
            <MetricsStrip
              map={activeMap}
              result={result}
              onOpen={() => setRightTab('metrics')}
            />
          )}
        </section>

        {rightCollapsed ? (
          <button
            type="button"
            className="pane-tab pane-tab-right"
            title="展开配方栏"
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
            aria-label="调整配方面板宽度"
            title="拖动调整右栏宽度"
            onPointerDown={beginResize}
          />

          <div className="dock-head">
            <div>
              <h2>
                {rightTab === 'recipe'
                  ? '当前配方'
                  : rightTab === 'card'
                    ? '卡片详情'
                    : rightTab === 'metrics'
                      ? '指标'
                      : rightTab === 'flow'
                        ? '算法流程'
                        : '运行'}
              </h2>
            </div>
            <div className="dock-head-actions">
              {rightTab === 'recipe' ? (
                <span className="count-badge">{recipeOrder.length} 张</span>
              ) : null}
              <button
                type="button"
                className="dock-collapse"
                title="收起配方栏"
                aria-label="收起配方栏"
                onClick={() => setRightCollapsed(true)}
              >
                <Icon name="chevronDown" size={13} />
              </button>
            </div>
          </div>

          <div className="inspector-tabs" role="tablist" aria-label="配方与检查器">
            <button
              type="button"
              className={rightTab === 'recipe' ? 'is-active' : ''}
              onClick={() => setRightTab('recipe')}
            >
              配方
            </button>
            <button
              type="button"
              className={rightTab === 'card' ? 'is-active' : ''}
              onClick={() => setRightTab('card')}
            >
              卡片
            </button>
            <button
              type="button"
              className={rightTab === 'metrics' ? 'is-active' : ''}
              onClick={() => setRightTab('metrics')}
            >
              指标
            </button>
            <button
              type="button"
              className={rightTab === 'flow' ? 'is-active' : ''}
              onClick={() => setRightTab('flow')}
            >
              流程
            </button>
            <button
              type="button"
              className={rightTab === 'run' ? 'is-active' : ''}
              onClick={() => setRightTab('run')}
            >
              运行
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
                    <strong>配方还是空的</strong>
                    <p>从左侧卡片库点选加入，再回到这里拖动排序。</p>
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
                            setIsAdjusting(true)
                            setPlaying(false)
                            setPlayhead(result.events.length)
                          }}
                          onAdjustEnd={() => {
                            setIsAdjusting(false)
                            setReplayNonce((value) => value + 1)
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
                              setToast('已取消排序：卡片拖出了配方区域')
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
                onToggle={() =>
                  updateCard(selectedCardId, { enabled: !selectedState.enabled })
                }
                onValue={(value) =>
                  updateCard(selectedCardId, {
                    value: clampCardValue(selectedCardId, value),
                  })
                }
                onAdjustStart={() => {
                  setIsAdjusting(true)
                  setPlaying(false)
                  setPlayhead(result.events.length)
                }}
                onAdjustEnd={() => {
                  setIsAdjusting(false)
                  setReplayNonce((value) => value + 1)
                }}
              />
            ) : (
              <div className="panel-empty">
                <span className="empty-icon">
                  <Icon name="sliders" size={18} />
                </span>
                <strong>还没有选中卡片</strong>
                <p>在“配方”里点击一张卡，查看它编译成什么、影响画布上的什么。</p>
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
              algorithm={result.algorithmLabel}
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
          title="展开播放栏"
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
            title="拖动调整播放栏高度"
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
  )
}