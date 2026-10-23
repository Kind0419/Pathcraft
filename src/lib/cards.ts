import type { CardGroup, CardId, CardsState } from './types'
import { tr, type Lang } from './i18n'

export type CardIcon =
  | 'compass'
  | 'diagonal'
  | 'clearance'
  | 'turn'
  | 'shield'
  | 'uturn'
  | 'angle'
  | 'cut'
  | 'route'
  | 'target'
  | 'smooth'
  | 'round'

export type CardKind =
  | 'weight'
  | 'radius'
  | 'angle'
  | 'budget'
  | 'passes'
  | 'choice'
  | 'toggle'

/** Where a card participates in the runtime pipeline. */
export type CardStage =
  | 'priority'
  | 'neighbor'
  | 'cost'
  | 'goal'
  | 'filter'
  | 'post'

export interface CardDef {
  id: CardId
  title: string
  subtitle: string
  /** The parameter this card actually exposes, e.g. `w_h` or `r_safe`. */
  param: string
  stage: CardStage
  group: CardGroup
  kind: CardKind
  icon: CardIcon
  accent: string
  defaultEnabled: boolean
  defaultValue: number
  defaultInRecipe: boolean
  options?: string[]
  min?: number
  max?: number
  step?: number
  unit?: string
  formula: string
  compiles: string
  visual: string
  detail: string
}

export const CARD_GROUPS: Array<{ id: CardGroup; label: string; hint: string }> = [
  { id: 'search', label: '搜索', hint: '排序与邻域' },
  { id: 'cost', label: '代价', hint: '目标函数' },
  { id: 'constraint', label: '约束', hint: '可行域' },
  { id: 'bridge', label: '后处理', hint: '几何修正' },
]

export const CARD_STAGES: Array<{
  id: CardStage
  label: string
  code: string
  hint: string
}> = [
  { id: 'priority', label: '优先级', code: 'ORDER', hint: '决定队列先弹出谁' },
  { id: 'neighbor', label: '邻域', code: 'EXPAND', hint: '决定从当前节点向哪里扩展' },
  { id: 'cost', label: '代价', code: 'COST', hint: '累加到 g，改变路径偏好' },
  { id: 'goal', label: '到达判定', code: 'TEST', hint: '到达判定条件' },
  { id: 'filter', label: '过滤', code: 'FILTER', hint: '硬约束，直接排除状态' },
  { id: 'post', label: '后处理', code: 'BRIDGE', hint: '搜索结束后修正几何' },
]

export const STAGE_LABEL: Record<CardStage, string> = Object.fromEntries(
  CARD_STAGES.map((stage) => [stage.id, stage.label]),
) as Record<CardStage, string>

export const CARD_DEFS: CardDef[] = [
  {
    id: 'strategy',
    title: '搜索策略',
    subtitle: '算法族与具体策略',
    param: 'mode',
    stage: 'priority',
    group: 'search',
    kind: 'choice',
    icon: 'compass',
    accent: '#2f5d50',
    defaultEnabled: true,
    defaultValue: 0,
    defaultInRecipe: true,
    options: [
      'A*',
      'Dijkstra',
      '贪心',
      'BFS',
      'DFS',
      '加权 A*',
      'RRT',
      'RRT*',
      'PRM',
      '可见性图',
      'JPS',
      'IDA*',
      '双向 A*',
      'Beam',
      'D* Lite',
      '蚁群 ACO',
      '遗传算法',
    ],
    formula: 'priority(n) = g + h · w_h   |   g   |   h   |   FIFO   |   LIFO   |   jump   |   τ^α·η^β',
    compiles: '排序键 · 队列优先级 / 连续采样 / 信息素',
    visual: '波前扩散 / 采样树 / 信息素场',
    detail:
      '图搜索按队列优先级扩张；JPS 跳对称段；IDA* 逐轮加深；双向 A* 两端相遇；Beam 每层裁剪；D* Lite 从终点反算并可复用；RRT / RRT* / PRM / 可见性图在连续空间采样；蚁群与遗传算法靠随机迭代改进。切换算法后，装配表里不适用于该算法的卡片会标注“不适用”。',
  },
  {
    id: 'heuristic',
    title: '启发式权重',
    subtitle: '估计距离在优先级中的权重',
    param: 'w_h',
    stage: 'priority',
    group: 'search',
    kind: 'weight',
    icon: 'compass',
    accent: '#2f5d50',
    defaultEnabled: true,
    defaultValue: 1,
    defaultInRecipe: true,
    min: 0,
    max: 2,
    step: 0.05,
    unit: '×',
    formula: 'h(n) = w_h · octile(n, G)',
    compiles: '优先级项 · f = g + h',
    visual: '目标方向场',
    detail:
      'w_h = 1 为标准 A*；w_h = 0 等价 Dijkstra，搜索会均匀铺开；w_h > 1 为加权 A*，收敛更快但不保证最优。',
  },
  {
    id: 'diagonal',
    title: '八邻域',
    subtitle: '允许斜向移动，禁止穿角',
    param: '8-neigh',
    stage: 'neighbor',
    group: 'search',
    kind: 'toggle',
    icon: 'diagonal',
    accent: '#2f5d50',
    defaultEnabled: true,
    defaultValue: 1,
    defaultInRecipe: true,
    formula: 'δ(n) = 8-neighborhood',
    compiles: '邻域 · 8 / 4',
    visual: '斜向路径段',
    detail:
      '关闭后为 4 邻域，路径呈阶梯形。斜向移动会检查两侧正交邻居，避免穿过障碍角缝；是否允许穿角由「允许切角」控制。',
  },
  {
    id: 'clearance',
    title: '间隙代价',
    subtitle: '贴墙惩罚权重',
    param: 'w_c',
    stage: 'cost',
    group: 'cost',
    kind: 'weight',
    icon: 'clearance',
    accent: '#9a7637',
    defaultEnabled: true,
    defaultValue: 0.5,
    defaultInRecipe: true,
    min: 0,
    max: 1.5,
    step: 0.05,
    unit: '×',
    formula: 'c(n) = w_c · max(0, d_safe − d(n))²',
    compiles: '代价项 · g += c(n)',
    visual: '间隙场',
    detail:
      'd(n) 是当前格到最近障碍的距离，d_safe 固定为 3.2 格。它不是硬约束：只提高贴墙的代价，路径仍可贴墙通过。',
  },
  {
    id: 'turn',
    title: '转角代价',
    subtitle: '单步转向惩罚权重',
    param: 'w_t',
    stage: 'cost',
    group: 'cost',
    kind: 'weight',
    icon: 'turn',
    accent: '#9a7637',
    defaultEnabled: true,
    defaultValue: 0.3,
    defaultInRecipe: true,
    min: 0,
    max: 1.5,
    step: 0.05,
    unit: '×',
    formula: 't(θ) = w_t · |Δθ| / 90°',
    compiles: '代价项 · g += t(θ)',
    visual: '折角标记',
    detail:
      '搜索状态包含当前朝向，同一格从不同方向进入会被视为不同状态。这是转角代价能减少折线、但不能替代最大转角硬约束的原因。',
  },
  {
    id: 'lengthWeight',
    title: '长度权重',
    subtitle: '基础步长代价系数',
    param: 'w_g',
    stage: 'cost',
    group: 'cost',
    kind: 'weight',
    icon: 'route',
    accent: '#9a7637',
    defaultEnabled: false,
    defaultValue: 1.5,
    defaultInRecipe: false,
    min: 0.5,
    max: 2.5,
    step: 0.05,
    unit: '×',
    formula: 'g += w_g · step',
    compiles: '代价项 · 步长缩放',
    visual: '路径长度权重的变化',
    detail:
      '把基础步长代价乘以 w_g。大于 1 时更偏向短路径，可能牺牲间隙或转角；小于 1 时允许绕远。',
  },
  {
    id: 'diagonalBias',
    title: '斜向偏好',
    subtitle: '正交步惩罚权重',
    param: 'w_d',
    stage: 'cost',
    group: 'cost',
    kind: 'weight',
    icon: 'diagonal',
    accent: '#9a7637',
    defaultEnabled: false,
    defaultValue: 0.15,
    defaultInRecipe: false,
    min: 0,
    max: 1,
    step: 0.05,
    unit: '×',
    formula: 'g += w_d · [step ⟂]',
    compiles: '代价项 · 正交步惩罚',
    visual: '斜向与正交段的颜色',
    detail:
      '只对上下左右移动加一项小惩罚，使斜向移动相对更便宜。它不会禁止正交移动，只改变路径偏好。',
  },
  {
    id: 'goalTolerance',
    title: '目标容差',
    subtitle: '到达判定半径',
    param: 'ε',
    stage: 'goal',
    group: 'cost',
    kind: 'radius',
    icon: 'target',
    accent: '#9a7637',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: false,
    min: 0,
    max: 3,
    step: 0.25,
    unit: '格',
    formula: 'dist(n, G) ≤ ε',
    compiles: '终止条件 · 到达圈',
    visual: '终点周围的容差圈',
    detail:
      '搜索进入容差圈就停止，适合“到附近即可”的任务。容差越大路径越短，但最终点与目标之间会保留相应距离。',
  },
  {
    id: 'cornerCut',
    title: '允许切角',
    subtitle: '允许斜穿障碍角缝',
    param: 'corner-cut',
    stage: 'filter',
    group: 'constraint',
    kind: 'toggle',
    icon: 'cut',
    accent: '#a45f43',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: false,
    formula: 'diag(n, m) ∧ ¬blocked(orthogonal)',
    compiles: '几何 · 斜穿角缝',
    visual: '斜线穿过障碍角',
    detail:
      '默认会检查斜向移动两侧的正交邻居，避免从两个障碍的角缝挤过去。打开后允许穿角，路径更短但更贴障碍。',
  },
  {
    id: 'collision',
    title: '安全膨胀',
    subtitle: '最小障碍间距（硬约束）',
    param: 'r_safe',
    stage: 'filter',
    group: 'constraint',
    kind: 'radius',
    icon: 'shield',
    accent: '#a45f43',
    defaultEnabled: true,
    defaultValue: 1.6,
    defaultInRecipe: true,
    min: 0,
    max: 2.4,
    step: 0.05,
    unit: '格',
    formula: 'd(n) ≥ r_safe',
    compiles: '硬约束 · 膨胀障碍',
    visual: '障碍周围的安全边界',
    detail:
      '硬约束，不是罚项。半径过大时可能直接无解，界面会显示“不可行”，而不是返回一条穿墙路径。',
  },
  {
    id: 'noUTurn',
    title: '禁止掉头',
    subtitle: '删除 180° 反向（硬约束）',
    param: 'Δθ ≠ 180°',
    stage: 'filter',
    group: 'constraint',
    kind: 'toggle',
    icon: 'uturn',
    accent: '#a45f43',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: false,
    formula: 'Δθ ≠ 180°',
    compiles: '硬约束 · 禁止反向',
    visual: '回折线段',
    detail:
      '在带朝向的状态中剪掉 180° 反向，适合走廊、单车通道这类掉头代价高的场景。关闭后允许原路折返。',
  },
  {
    id: 'maxTurn',
    title: '最大转角',
    subtitle: '单步转向上限（硬约束）',
    param: 'θ_max',
    stage: 'filter',
    group: 'constraint',
    kind: 'angle',
    icon: 'angle',
    accent: '#a45f43',
    defaultEnabled: false,
    defaultValue: 90,
    defaultInRecipe: false,
    min: 45,
    max: 180,
    step: 45,
    unit: '°',
    formula: 'Δθ ≤ θ_max',
    compiles: '硬约束 · 最大转角',
    visual: '超出上限的急弯',
    detail:
      '硬约束。限制到 45° 时路径更顺，但窄门或凹槽可能直接无解；界面会明确显示不可行。',
  },
  {
    id: 'budget',
    title: '扩展预算',
    subtitle: '最大扩展节点数（硬约束）',
    param: 'N_max',
    stage: 'filter',
    group: 'constraint',
    kind: 'budget',
    icon: 'target',
    accent: '#a45f43',
    defaultEnabled: false,
    defaultValue: 12000,
    defaultInRecipe: false,
    min: 1000,
    max: 30000,
    step: 1000,
    unit: '节点',
    formula: 'expanded ≤ N_max',
    compiles: '硬约束 · 搜索预算',
    visual: '预算耗尽的位置',
    detail:
      '每展开一个状态就计数，超过上限直接判定本轮失败。用来观察“预算不够时，算法会停在哪里”。',
  },
  {
    id: 'swarmWidth',
    title: '候选宽度',
    subtitle: '每轮保留的候选数',
    param: 'm',
    stage: 'priority',
    group: 'search',
    kind: 'budget',
    icon: 'compass',
    accent: '#2f5d50',
    defaultEnabled: true,
    defaultValue: 24,
    defaultInRecipe: false,
    min: 4,
    max: 60,
    step: 1,
    unit: '个',
    formula: 'm = |frontier|',
    compiles: '束搜索保留数 / 蚁群数量 / 种群规模',
    visual: '当前层的候选数量',
    detail:
      '只对三种算法生效：Beam 每层保留的节点数、蚁群每轮的蚂蚁数、遗传算法每代的个体数。值越大越不容易漏掉解，但每一轮更慢。',
  },
  {
    id: 'iterations',
    title: '迭代轮数',
    subtitle: '随机搜索的代数',
    param: 'T',
    stage: 'priority',
    group: 'search',
    kind: 'budget',
    icon: 'round',
    accent: '#2f5d50',
    defaultEnabled: true,
    defaultValue: 34,
    defaultInRecipe: false,
    min: 4,
    max: 120,
    step: 1,
    unit: '轮',
    formula: 'for t = 1 … T',
    compiles: '蚁群迭代 / 遗传代数',
    visual: '信息素收敛过程',
    detail:
      '只对蚁群和遗传算法生效。轮数越多结果越稳定，但求解时间线性增长；随机算法不会因为轮数多就保证最优。',
  },
  {
    id: 'incremental',
    title: '增量复用',
    subtitle: '复用上一轮的距离场',
    param: 'reuse',
    stage: 'priority',
    group: 'search',
    kind: 'toggle',
    icon: 'route',
    accent: '#2f5d50',
    defaultEnabled: true,
    defaultValue: 1,
    defaultInRecipe: false,
    formula: 'g, rhs ← last run',
    compiles: 'D* Lite · 缓存命中',
    visual: '上一轮的搜索区域',
    detail:
      '只对 D* Lite 生效，默认开启。移动起点时距离场不需要重算，所以扩展数会骤降；关闭后每轮都从终点重新反算，用来对比增量到底省了多少。',
  },
  {
    id: 'smooth',
    title: '可见性拉直',
    subtitle: '删除无遮挡的冗余拐点',
    param: 'LOS',
    stage: 'post',
    group: 'bridge',
    kind: 'toggle',
    icon: 'smooth',
    accent: '#416877',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: true,
    formula: 'path ← lineOfSight(path)',
    compiles: '后处理 · 可见性剪枝',
    visual: '原始折线与拉直路径',
    detail:
      '沿折线做可见性检查，删除能被直线替代的拐点。拉直后会重新计算长度、最小间隙和代价，指标仍来自最终路径。',
  },
  {
    id: 'round',
    title: 'Chaikin 平滑',
    subtitle: '折角圆滑轮数',
    param: 'passes',
    stage: 'post',
    group: 'bridge',
    kind: 'passes',
    icon: 'round',
    accent: '#416877',
    defaultEnabled: false,
    defaultValue: 2,
    defaultInRecipe: false,
    min: 1,
    max: 4,
    step: 1,
    unit: '轮',
    formula: 'path ← chaikin(path, passes)',
    compiles: '后处理 · 角点圆滑',
    visual: '折角处的小弧线',
    detail:
      '对路径做多轮 Chaikin 切角，并逐段进行碰撞检查。任一段不通过时回退到平滑前路径；它只改变几何，不改变搜索代价。',
  },
  {
    id: 'simplify',
    title: '路径抽稀',
    subtitle: '共线点合并容差',
    param: 'τ',
    stage: 'post',
    group: 'bridge',
    kind: 'radius',
    icon: 'route',
    accent: '#416877',
    defaultEnabled: false,
    defaultValue: 0.5,
    defaultInRecipe: false,
    min: 0,
    max: 2,
    step: 0.1,
    unit: '格',
    formula: 'simplify(path, τ)',
    compiles: '后处理 · Douglas–Peucker',
    visual: '被删除的中间点',
    detail:
      '垂直距离不超过 τ 且线段无碰撞时删除中间点。若抽稀后的路径发生碰撞，就保留抽稀前的结果。',
  },
]

export const CARD_BY_ID: Record<CardId, CardDef> = Object.fromEntries(
  CARD_DEFS.map((card) => [card.id, card]),
) as Record<CardId, CardDef>

export function createDefaultCards(): CardsState {
  return Object.fromEntries(
    CARD_DEFS.map((card) => [
      card.id,
      { enabled: card.defaultEnabled, value: card.defaultValue },
    ]),
  ) as CardsState
}

export function createDefaultRecipeOrder(): CardId[] {
  return CARD_DEFS.filter((card) => card.defaultInRecipe).map((card) => card.id)
}

export function cardValueLabel(
  card: CardDef,
  value: number,
  lang: Lang = 'zh',
): string {
  if (card.kind === 'toggle') return tr(lang, value > 0 ? '开' : '关')
  if (card.kind === 'choice') {
    const option = card.options?.[Math.round(value)] ?? `${value}`
    return tr(lang, option)
  }
  const digits =
    card.kind === 'angle' || card.kind === 'budget' || card.kind === 'passes'
      ? 0
      : 2
  const rawUnit = card.unit ?? (card.kind === 'weight' ? '×' : '')
  const unit = rawUnit ? tr(lang, rawUnit) : ''
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`
}