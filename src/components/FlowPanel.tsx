import { useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  CARD_BY_ID,
  CARD_STAGES,
  STAGE_LABEL,
  cardValueLabel,
} from '../lib/cards'
import { fmtNum, plural, tr, useLang } from '../lib/i18n'
import type { CardId, CardsState, GridMap, PlanResult } from '../lib/types'
import { Icon } from './Icon'

interface FlowPanelProps {
  cards: CardsState
  order: CardId[]
  result: PlanResult
  map: GridMap
  playhead: number
  playing: boolean
  algorithm: string
  focusCard: CardId | null
  onReorder: (id: CardId, index: number) => void
  onSelectCard: (id: CardId) => void
  onHoverStart: (id: CardId) => void
  onHoverEnd: () => void
}

function fmt(value: number, digits = 2): string {
  return value.toFixed(digits)
}

/**
 * The lines of the main loop, in execution order.
 *
 * One replay frame is one search event, and one event is a whole iteration —
 * eight of these lines inside sixteen milliseconds. Lighting them literally
 * would be a strobe, not an explanation. So the walk is *paced*: about one line
 * per four frames, which is fast enough to read as "this is running" and slow
 * enough to follow. Where the data is decisive it overrides the pace: arrival
 * lights the arrival line, and a run that ends lights its own ending.
 *
 * The canvas is the exact record. This panel is the readable one, and the
 * difference is deliberate rather than an approximation pretending to be data.
 */
type StepId =
  | 'init'
  | 'pop'
  | 'dedupe'
  | 'count'
  | 'goal'
  | 'budget'
  | 'neighbors'
  | 'filter'
  | 'relax'
  | 'return'
  | 'fail'

const LOOP_STEPS: StepId[] = [
  'pop',
  'dedupe',
  'count',
  'goal',
  'budget',
  'neighbors',
  'filter',
  'relax',
]
/** Replay frames per highlighted line. */
const FRAMES_PER_STEP = 4

function buildSparkline(events: PlanResult['events']): string {
  if (events.length < 2) return ''
  const stride = Math.max(1, Math.ceil(events.length / 90))
  const samples: number[] = []
  for (let i = 0; i < events.length; i += stride) {
    samples.push(events[i].openSize)
  }
  const last = events[events.length - 1]
  if (samples[samples.length - 1] !== last.openSize) samples.push(last.openSize)
  const max = Math.max(1, ...samples)
  return samples
    .map((value, index) => {
      const x = (index / Math.max(1, samples.length - 1)) * 100
      const y = 30 - (value / max) * 26
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

export function FlowPanel({
  cards,
  order,
  result,
  map,
  playhead,
  playing,
  algorithm,
  focusCard,
  onReorder,
  onSelectCard,
  onHoverStart,
  onHoverEnd,
}: FlowPanelProps) {
  const lang = useLang()
  const [dragId, setDragId] = useState<CardId | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const draggedRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)

  const focus = focusCard ? CARD_BY_ID[focusCard] : null
  const isLinked = (ids: CardId[]) => Boolean(focusCard && ids.includes(focusCard))
  const postFocus = focus?.stage === 'post'

  const eventIndex = Math.max(0, Math.min(playhead, result.events.length))
  const current = eventIndex > 0 ? result.events[eventIndex - 1] : null
  const finished = result.events.length > 0 && eventIndex >= result.events.length
  const success = finished && result.status === 'success'
  const failed = finished && result.status === 'infeasible'
  const done = success || failed
  const phase: 'init' | 'loop' | 'done' | 'fail' = !current
    ? 'init'
    : finished
      ? result.status === 'success'
        ? 'done'
        : 'fail'
      : 'loop'

  const activeStep: StepId =
    phase === 'init' ? 'init' : phase === 'done' ? 'return' : phase === 'fail' ? 'fail' : LOOP_STEPS[Math.floor(playhead / FRAMES_PER_STEP) % LOOP_STEPS.length]
  /**
   * Show the caret wherever a frame has been reached: while running, while
   * paused on a frame the user chose to inspect, and on the last frame — where
   * it parks on the terminating line (`return reconstruct` / `return ∅`) so the
   * ending is marked rather than the panel going blank.
   *
   * The one state without a caret is frame zero before playback: nothing has
   * executed, so nothing is lit. A static panel with a bright line on it is
   * exactly the "decorative" failure this round is about.
   */
  const showLive = playing || current !== null

  const liveClass = (step: StepId, extra = '') =>
    `trace-code${extra ? ` ${extra}` : ''}${showLive && activeStep === step ? ' is-live' : ''}`

  const mode = cards.strategy.enabled ? Math.round(cards.strategy.value) : 0
  const heuristic = cards.heuristic.enabled ? cards.heuristic.value : 0
  const budgetEnabled = cards.budget.enabled
  const budgetValue = Math.round(cards.budget.value)
  const expandedNow = finished ? result.expanded : eventIndex
  const budgetExceeded =
    budgetEnabled && (finished ? result.expanded >= budgetValue : expandedNow > budgetValue)
  const goalDistance = cards.goalTolerance.enabled ? cards.goalTolerance.value : 0

  const priorityFormula =
    mode === 1
      ? 'priority(n) = g(n)'
      : mode === 2
        ? 'priority(n) = h(n)'
        : mode === 3
          ? 'priority(n) = seq(n)   · FIFO'
          : mode === 4
            ? 'priority(n) = −seq(n)  · LIFO'
            : mode === 5
              ? 'priority(n) = g(n) + 1.50 · h(n)'
              : `priority(n) = g(n) + ${fmt(heuristic)} · h(n)`

  const activeFilters = [
    cards.collision.enabled ? `d ≥ ${fmt(cards.collision.value)} ${tr(lang, '格')}` : null,
    cards.cornerCut.enabled ? tr(lang, '允许切角') : tr(lang, '禁止穿角'),
    cards.noUTurn.enabled ? tr(lang, '禁止掉头') : null,
    cards.maxTurn.enabled ? `Δθ ≤ ${Math.round(cards.maxTurn.value)}°` : null,
  ].filter(Boolean) as string[]

  const costTerms = [
    `w_g ${cards.lengthWeight.enabled ? fmt(cards.lengthWeight.value) : '1.00'}`,
    cards.clearance.enabled ? `w_c ${fmt(cards.clearance.value)}` : null,
    cards.turn.enabled ? `w_t ${fmt(cards.turn.value)}` : null,
    cards.diagonalBias.enabled ? `w_d ${fmt(cards.diagonalBias.value)}` : null,
  ].filter(Boolean) as string[]

  const postCards = order
    .map((id) => ({ id, def: CARD_BY_ID[id], state: cards[id] }))
    .filter((entry) => entry.def.stage === 'post' && entry.state.enabled)

  const sparkline = useMemo(() => buildSparkline(result.events), [result.events])
  const peakOpen = useMemo(
    () => result.events.reduce((max, event) => Math.max(max, event.openSize), 0),
    [result.events],
  )

  const stageCounts = CARD_STAGES.map((stage) => ({
    ...stage,
    count: order.filter(
      (id) => CARD_BY_ID[id].stage === stage.id && cards[id].enabled,
    ).length,
  }))

  function finishDrag() {
    document.body.classList.remove('is-dragging-card')
    setDragId(null)
    setOverIndex(null)
  }

  const trace = result.trace
  const isGraph = !trace || trace.kind === 'graph'

  return (
    <div className={`panel-scroll flow-panel${playing ? ' is-playing' : ''}`}>
      <div className="flow-head">
        <span className="flow-kicker">{tr(lang, '实时回放')}</span>
        <div className="flow-title">
          <h3>{tr(lang, '运行轨迹')}</h3>
          <span className="flow-algo">{algorithm}</span>
        </div>
        <p>
          {tr(lang, '按回放帧高亮实际执行分支；右侧显示当前节点与队列状态。卡片按编译位点挂在流程上，拖动可同步装配顺序。')}
        </p>
      </div>

      <div className="trace-frame">
        <div>
          <span>{tr(lang, '当前节点')}</span>
          <strong>
            {current
              ? `(${current.x < map.width ? current.x : current.x.toFixed(1)}, ${
                  current.y < map.height ? current.y : current.y.toFixed(1)
                })`
              : 'S'}
          </strong>
        </div>
        <div>
          <span>g / h / f</span>
          <strong>
            {current ? `${fmt(current.g)} / ${fmt(current.h)} / ${fmt(current.f)}` : '—'}
          </strong>
        </div>
        <div>
          <span>{tr(lang, '开放集')}</span>
          <strong>{current ? current.openSize : '—'}</strong>
        </div>
        <div>
          <span>{tr(lang, '扩展状态')}</span>
          <strong>{fmtNum(lang, expandedNow)}</strong>
        </div>
      </div>

      <div className="flow-section-label">
        <span>{tr(lang, '控制流')}</span>
        <em>{playing ? tr(lang, '回放中') : done ? tr(lang, '本轮结束') : tr(lang, '已暂停')}</em>
      </div>

      <ol className="trace-list">
        <li className={`trace-stage ${phase === 'init' ? 'is-active' : 'is-past'}`}>
          <span className="trace-node">01</span>
          <div className="trace-body">
            <div className="trace-stage-head">
              <strong>{tr(lang, '初始化')}</strong>
              <span>{isGraph ? 'INIT' : trace?.kind.toUpperCase()}</span>
            </div>
            {isGraph ? (
              <>
                <div className={liveClass('init')}>
                  <code>open ← {'{(S, dir=∅, g=0)}'}</code>
                  <span>open 1</span>
                </div>
                <div className={liveClass('init')}>
                  <code>
                    h(S) = {fmt(result.events[0]?.h ?? 0)} · f(S) = {fmt(result.events[0]?.f ?? 0)}
                  </code>
                  <span>
                    {cards.collision.enabled
                      ? `r_safe ${fmt(cards.collision.value)}`
                      : tr(lang, '无障碍膨胀')}
                  </span>
                </div>
              </>
            ) : (
              (trace?.init ?? []).map((line) => (
                <div className="trace-code" key={line}>
                  <code>{line}</code>
                  <span />
                </div>
              ))
            )}
          </div>
        </li>

        <li
          className={`trace-stage trace-loop ${phase === 'loop' ? 'is-active' : done ? 'is-past' : ''}`}
        >
          <span className="trace-node">02</span>
          <div className="trace-body">
            <div className="trace-stage-head">
              <strong>{isGraph ? tr(lang, '主循环') : tr(lang, '迭代循环')}</strong>
              <span>{isGraph ? 'WHILE OPEN ≠ ∅' : trace?.loopLabel}</span>
            </div>

            {isGraph ? (
              <>
                <div
                  className={`trace-code trace-formula ${isLinked(['strategy', 'heuristic']) ? 'is-linked' : ''}`}
                >
                  <code>{priorityFormula}</code>
                  <span>
                    {mode === 3 || mode === 4 ? tr(lang, '队列序') : tr(lang, 'f 值最小')}
                  </span>
                </div>
                <div className="trace-code">
                  <code>while open ≠ ∅:</code>
                  <span>{current ? `open ${current.openSize}` : 'open 1'}</span>
                </div>
                <div className={liveClass('pop', 'is-indent')}>
                  <code>n ← pop_min(open)</code>
                  <span>{current ? `n (${current.x}, ${current.y})` : 'n = S'}</span>
                </div>
                <div className={liveClass('dedupe', 'is-indent')}>
                  <code>if closed[n]: continue</code>
                  <span className="trace-chip">{tr(lang, '去重')}</span>
                </div>
                <div className={liveClass('count', 'is-indent')}>
                  <code>expanded += 1</code>
                  <span>
                    {fmtNum(lang, expandedNow)}
                    {budgetEnabled ? ` / ${fmtNum(lang, budgetValue)}` : ''}
                  </span>
                </div>
                <div
                  className={liveClass(
                    'goal',
                    `is-indent ${success ? 'is-hit' : ''} ${isLinked(['goalTolerance']) ? 'is-linked' : ''}`,
                  )}
                >
                  <code>if dist(n, G) ≤ {fmt(goalDistance)}: break</code>
                  <span className={`trace-chip ${success ? 'is-yes' : 'is-no'}`}>
                    {success ? tr(lang, '是 → 回溯') : tr(lang, '否')}
                  </span>
                </div>
                <div
                  className={liveClass(
                    'budget',
                    `is-indent ${budgetExceeded ? 'is-hit' : ''} ${isLinked(['budget']) ? 'is-linked' : ''}`,
                  )}
                >
                  <code>if expanded &gt; N_max: break</code>
                  <span className={`trace-chip ${budgetExceeded ? 'is-yes' : 'is-no'}`}>
                    {budgetEnabled
                      ? budgetExceeded
                        ? tr(lang, '是 → 无解')
                        : tr(lang, '否')
                      : tr(lang, '未启用')}
                  </span>
                </div>
                <div className={liveClass('neighbors', `is-indent ${isLinked(['diagonal']) ? 'is-linked' : ''}`)}>
                  <code>for m in δ(n):</code>
                  <span className="trace-chip">
                    {cards.diagonal.enabled ? tr(lang, '8 邻域') : tr(lang, '4 邻域')}
                  </span>
                </div>
                <div
                  className={liveClass(
                    'filter',
                    `is-indent-2 ${isLinked(['collision', 'cornerCut', 'noUTurn', 'maxTurn']) ? 'is-linked' : ''}`,
                  )}
                >
                  <code>if filter(m): continue</code>
                  <span className="trace-chip">
                    {activeFilters.join(' · ') || tr(lang, '无障碍过滤')}
                  </span>
                </div>
                <div
                  className={liveClass(
                    'relax',
                    `is-indent-2 ${isLinked(['clearance', 'turn', 'lengthWeight', 'diagonalBias']) ? 'is-linked' : ''}`,
                  )}
                >
                  <code>if g + c &lt; g(m): push</code>
                  <span className="trace-chip">{costTerms.join(' · ')}</span>
                </div>
              </>
            ) : (
              <>
                <div className="trace-code trace-formula">
                  <code>
                    n ← ({current ? current.x.toFixed(1) : '—'}, {current ? current.y.toFixed(1) : '—'})
                  </code>
                  <span>
                    {current
                      ? `g ${fmt(current.g)} · h ${fmt(current.h)} · f ${fmt(current.f)}`
                      : '—'}
                  </span>
                </div>
                {(trace?.loop ?? []).map((line, index) => {
                  const steps = trace?.loop.length ?? 0
                  const onIt =
                    showLive &&
                    phase === 'loop' &&
                    steps > 0 &&
                    Math.floor(playhead / FRAMES_PER_STEP) % steps === index
                  return (
                    <div
                      className={`trace-code is-indent${onIt ? ' is-live' : ''}`}
                      key={line}
                    >
                      <code>{line}</code>
                      <span />
                    </div>
                  )
                })}
                <div className={`trace-code is-indent ${budgetExceeded ? 'is-hit' : ''}`}>
                  <code>expanded &gt; N_max ?</code>
                  <span className={`trace-chip ${budgetExceeded ? 'is-yes' : 'is-no'}`}>
                    {budgetEnabled
                      ? `${fmtNum(lang, expandedNow)} / ${fmtNum(lang, budgetValue)}`
                      : tr(lang, '未启用')}
                  </span>
                </div>
                {result.rounds ? (
                  <div className="trace-code is-indent">
                    <code>{tr(lang, '迭代轮数')}</code>
                    <span>{result.rounds}</span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </li>

        <li className={`trace-stage ${done ? 'is-active' : ''}`}>
          <span className="trace-node">03</span>
          <div className="trace-body">
            <div className="trace-stage-head">
              <strong>{tr(lang, '终止')}</strong>
              <span>RETURN</span>
            </div>
            {success ? (
              <>
                <div className={liveClass('return')}>
                  <code>{isGraph ? 'return reconstruct(parent, n_goal)' : trace?.terminate[0]}</code>
                  <span className="trace-chip is-yes">{tr(lang, '命中终点')}</span>
                </div>
                <div className="trace-code is-indent">
                  <code>
                    {lang === 'en'
                      ? `${result.rawPath.length} points · open ${result.openAtEnd}`
                      : `${result.rawPath.length} 个路径点 · open 剩余 ${result.openAtEnd}`}
                  </code>
                  <span>{fmt(result.pathLength * map.cellSize)} m</span>
                </div>
              </>
            ) : failed ? (
              <>
                <div className={liveClass('fail')}>
                  <code>return ∅</code>
                  <span className="trace-chip is-no">
                    {budgetExceeded ? tr(lang, '预算耗尽') : tr(lang, '开放集为空')}
                  </span>
                </div>
                <div className="trace-code is-indent">
                  <code>
                    {lang === 'en'
                      ? `expanded = ${fmtNum(lang, result.expanded)} · events retained`
                      : `expanded = ${fmtNum(lang, result.expanded)} · 保留搜索事件`}
                  </code>
                  <span>infeasible</span>
                </div>
              </>
            ) : (
              <div className="trace-code">
                <code>{tr(lang, '等待主循环退出…')}</code>
                <span>{playing ? tr(lang, '回放中') : tr(lang, '暂停')}</span>
              </div>
            )}
          </div>
        </li>

        <li className={`trace-stage ${success ? 'is-active' : ''} ${postFocus ? 'is-linked' : ''}`}>
          <span className="trace-node">04</span>
          <div className="trace-body">
            <div className="trace-stage-head">
              <strong>{tr(lang, '后处理')}</strong>
              <span>BRIDGE</span>
            </div>
            {success ? (
              <>
                <div className="trace-code">
                  <code>path ← recipe.post(path)</code>
                  <span>{plural(lang, postCards.length, '个处理器', 'processor')}</span>
                </div>
                {postCards.length > 0 ? (
                  <div className="trace-chips">
                    {postCards.map(({ id, def, state }) => (
                      <button
                        key={id}
                        type="button"
                        className="trace-card-chip"
                        style={{ '--chip-accent': def.accent } as CSSProperties}
                        onClick={() => onSelectCard(id)}
                        onMouseEnter={() => onHoverStart(id)}
                        onMouseLeave={onHoverEnd}
                      >
                        <span>{tr(lang, def.title)}</span>
                        <em>{cardValueLabel(def, state.value, lang)}</em>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="trace-empty">
                    {tr(lang, '没有启用的后处理器，直接输出搜索路径。')}
                  </p>
                )}
              </>
            ) : (
              <p className="trace-empty">{tr(lang, '无可行路径，后处理不会执行。')}</p>
            )}
          </div>
        </li>

        <li className={`trace-stage ${success ? 'is-active' : ''}`}>
          <span className="trace-node">05</span>
          <div className="trace-body">
            <div className="trace-stage-head">
              <strong>{tr(lang, '输出')}</strong>
              <span>METRICS</span>
            </div>
            <div className="trace-output">
              <div>
                <span>{tr(lang, '长度')}</span>
                <strong>{success ? `${fmt(result.pathLength * map.cellSize)} m` : '—'}</strong>
              </div>
              <div>
                <span>{tr(lang, '路径点')}</span>
                <strong>{success ? result.waypoints : '—'}</strong>
              </div>
              <div>
                <span>{tr(lang, '最小间隙')}</span>
                <strong>
                  {success ? `${fmt(result.minClearance * map.cellSize)} m` : '—'}
                </strong>
              </div>
              <div>
                <span>{tr(lang, '求解')}</span>
                <strong>{fmt(result.solveTime, 1)} ms</strong>
              </div>
            </div>
            {result.note ? <p className="trace-note">{result.note}</p> : null}
          </div>
        </li>
      </ol>

      <div className="flow-section-label">
        <span>{tr(lang, '开放集规模')}</span>
        <em>{lang === 'en' ? `peak ${fmtNum(lang, peakOpen)}` : `峰值 ${fmtNum(lang, peakOpen)}`}</em>
      </div>
      <div className="trace-spark" aria-hidden="true">
        {sparkline ? (
          <svg viewBox="0 0 100 32" preserveAspectRatio="none">
            <polyline points={sparkline} />
          </svg>
        ) : (
          <span>{tr(lang, '暂无搜索事件')}</span>
        )}
      </div>

      <div className="flow-section-label">
        <span>{tr(lang, '卡片装配')}</span>
        <em>{tr(lang, '拖动行 → 同步装配')}</em>
      </div>
      <div className="assembly-map">
        {stageCounts.map((stage) => (
          <span key={stage.id} className={`assembly-stage is-${stage.id}`}>
            {tr(lang, stage.label)}
            <em>{stage.count}</em>
          </span>
        ))}
      </div>

      <div className="assembly-list" ref={listRef}>
        {order.length === 0 ? (
          <p className="trace-empty">{tr(lang, '装配为空。从左侧组件库加入卡片。')}</p>
        ) : (
          order.map((id, index) => {
            const def = CARD_BY_ID[id]
            const state = cards[id]
            return (
              <div
                key={id}
                className={`assembly-row ${state.enabled ? '' : 'is-off'} ${
                  dragId === id ? 'is-dragging' : ''
                } ${overIndex === index ? 'is-over' : ''}`}
                draggable
                onClick={() => {
                  if (draggedRef.current) {
                    draggedRef.current = false
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
                  draggedRef.current = true
                  setDragId(id)
                }}
                onDragEnd={() => {
                  finishDrag()
                  window.setTimeout(() => {
                    draggedRef.current = false
                  }, 120)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  if (!dragId) return
                  const rect = event.currentTarget.getBoundingClientRect()
                  const nextIndex =
                    event.clientY > rect.top + rect.height / 2 ? index + 1 : index
                  setOverIndex(nextIndex)
                  const list = listRef.current
                  if (list) {
                    const listRect = list.getBoundingClientRect()
                    if (event.clientY < listRect.top + 28) list.scrollTop -= 10
                    else if (event.clientY > listRect.bottom - 28) {
                      list.scrollTop += 10
                    }
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragId) onReorder(dragId, overIndex ?? index)
                  finishDrag()
                }}
              >
                <span className="assembly-order">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className={`assembly-stage is-${def.stage}`}>
                  {tr(lang, STAGE_LABEL[def.stage])}
                </span>
                <span className="assembly-copy">
                  <strong>{tr(lang, def.title)}</strong>
                  <em>{def.param}</em>
                </span>
                <span className="assembly-value">
                  {state.enabled ? cardValueLabel(def, state.value, lang) : tr(lang, '停用状态')}
                </span>
                <span className="assembly-grip" aria-hidden="true">
                  <Icon name="grip" size={11} />
                </span>
              </div>
            )
          })
        )}
      </div>

      <p className="flow-hint">
        {tr(lang, '流程按当前回放帧高亮。暂停在任意一帧，可以对照画布查看当时弹出的节点与代价。')}
      </p>
    </div>
  )
}
