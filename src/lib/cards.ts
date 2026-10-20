import type { CardGroup, CardId, CardsState } from './types'

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

export type CardKind = 'weight' | 'radius' | 'angle' | 'budget' | 'choice' | 'toggle'

export interface CardDef {
  id: CardId
  title: string
  subtitle: string
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
  { id: 'search', label: '搜索', hint: '怎么找' },
  { id: 'cost', label: '代价', hint: '想要什么' },
  { id: 'constraint', label: '约束', hint: '不能什么' },
  { id: 'bridge', label: '后处理', hint: '把解变顺' },
]

export const CARD_DEFS: CardDef[] = [
  {
    id: 'strategy',
    title: '搜索策略',
    subtitle: '切换队列优先级与遍历规则',
    group: 'search',
    kind: 'choice',
    icon: 'compass',
    accent: '#1f4e5f',
    defaultEnabled: true,
    defaultValue: 0,
    defaultInRecipe: true,
    options: ['A*', 'Dijkstra', '贪心', 'BFS', 'DFS', '加权 A*'],
    formula: 'strategy := A* / Dijkstra / Greedy / BFS / DFS',
    compiles: '算法 · 队列优先级',
    visual: '搜索波前的扩散方式',
    detail:
      'A* 按 g+h 排序；Dijkstra 只按 g；Greedy 只按 h；BFS 按入队顺序；DFS 按后进先出；加权 A* 用 1.5× 启发式换取更快收敛。代价项和硬约束仍然会参与路径评价。',
  },  {
    id: 'heuristic',
    title: '启发式引导',
    subtitle: '用启发式估计到终点的距离',
    group: 'search',
    kind: 'weight',
    icon: 'compass',
    accent: '#1f4e5f',
    defaultEnabled: true,
    defaultValue: 1,
    defaultInRecipe: true,
    min: 0,
    max: 2,
    step: 0.05,
    unit: '×',
    formula: 'h(n) = w · octile(n, goal)',
    compiles: '优先级项  f = g + h',
    visual: '目标方向场 · 前沿偏移',
    detail:
      'w = 1 为标准 A*；w = 0 退化为 Dijkstra，搜索会均匀铺开；w > 1 为加权 A*，更快但不保证最优。',
  },
  {
    id: 'diagonal',
    title: '八邻域搜索',
    subtitle: '允许 8 邻域移动，路径更短',
    group: 'search',
    kind: 'toggle',
    icon: 'diagonal',
    accent: '#1f4e5f',
    defaultEnabled: true,
    defaultValue: 1,
    defaultInRecipe: true,
    formula: 'neighbors = 8',
    compiles: '邻域 8 · 禁止穿角',
    visual: '路径折线出现斜段',
    detail:
      '关闭后为 4 邻域，路径呈阶梯形；斜走时会检查两个正交邻居，避免穿过障碍角缝。',
  },
  {
    id: 'clearance',
    title: '间隙代价',
    subtitle: '用间隙代价让路径远离障碍',
    group: 'cost',
    kind: 'weight',
    icon: 'clearance',
    accent: '#8a6a2f',
    defaultEnabled: true,
    defaultValue: 0.5,
    defaultInRecipe: true,
    min: 0,
    max: 1.5,
    step: 0.05,
    unit: '×',
    formula: 'c(n) = w · max(0, d_safe − d(n))²',
    compiles: '代价项  g += c(n)',
    visual: '间隙场 · 路径被墙推开',
    detail:
      'd(n) 是当前格到最近障碍的距离，d_safe 是期望的安全距离；它不阻止贴墙，只提高贴墙的代价。',
  },
  {
    id: 'turn',
    title: '转角代价',
    subtitle: '用转角代价减少折返和急弯',
    group: 'cost',
    kind: 'weight',
    icon: 'turn',
    accent: '#8a6a2f',
    defaultEnabled: true,
    defaultValue: 0.3,
    defaultInRecipe: true,
    min: 0,
    max: 1.5,
    step: 0.05,
    unit: '×',
    formula: 't(θ) = w · |Δθ| / 90°',
    compiles: '代价项  g += t(θ)',
    visual: '折角变少 · 路径拉顺',
    detail:
      '搜索状态包含当前朝向，因此同一格从不同方向进入会被视为不同状态；这是转角代价生效的原因。',
  },
  {
    id: 'lengthWeight',
    title: '长度权重',
    subtitle: '提高长度在总代价里的权重',
    group: 'cost',
    kind: 'weight',
    icon: 'route',
    accent: '#8a6a2f',
    defaultEnabled: false,
    defaultValue: 1.5,
    defaultInRecipe: false,
    min: 0.5,
    max: 2.5,
    step: 0.05,
    unit: '×',
    formula: 'w_g · g',
    compiles: '代价项  w_g · 步长',
    visual: '路径长度权重的变化',
    detail:
      '把基础步长代价乘以 w_g。大于 1 时更偏向短路径，可能牺牲间隙或转角；小于 1 时允许绕远。',
  },
  {
    id: 'diagonalBias',
    title: '斜向偏好',
    subtitle: '给正交步加一点惩罚，鼓励走斜线',
    group: 'cost',
    kind: 'weight',
    icon: 'diagonal',
    accent: '#8a6a2f',
    defaultEnabled: false,
    defaultValue: 0.15,
    defaultInRecipe: false,
    min: 0,
    max: 1,
    step: 0.05,
    unit: '×',
    formula: 'g += w_d · o',
    compiles: '代价项  正交步惩罚',
    visual: '更愿意走斜线',
    detail:
      '对上下左右移动加一项小惩罚，斜向移动相对更便宜。它不会禁止正交移动，只改变路径偏好。',
  },
  {
    id: 'goalTolerance',
    title: '目标容差',
    subtitle: '进入终点附近就算到达',
    group: 'cost',
    kind: 'radius',
    icon: 'target',
    accent: '#8a6a2f',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: false,
    min: 0,
    max: 3,
    step: 0.25,
    unit: '格',
    formula: '||n - g|| ≤ ε',
    compiles: '目标区域 · 容差 ε',
    visual: '终点周围的到达圈',
    detail:
      '搜索进入终点容差圈就停止，适合“到附近即可”的任务。容差越大，路径越短，但最终点到目标仍有距离。',
  },
  {
    id: 'cornerCut',
    title: '允许切角',
    subtitle: '允许从两个障碍的角缝斜穿',
    group: 'constraint',
    kind: 'toggle',
    icon: 'cut',
    accent: '#8f5540',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: false,
    formula: 'cornerCut = true',
    compiles: '几何 · 允许斜穿角缝',
    visual: '斜线可穿过障碍角',
    detail:
      '默认会检查斜向移动两侧的正交邻居，避免从两个障碍的角缝里挤过去。打开后允许穿角，路径更短但更贴障碍。',
  },
  {
    id: 'collision',
    title: '安全膨胀',
    subtitle: '硬约束：和障碍至少保持这个半径',
    group: 'constraint',
    kind: 'radius',
    icon: 'shield',
    accent: '#8f5540',
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
      '硬约束，不是罚项。半径过大时可能直接无解；界面会明确显示“不可行”，而不是返回一条穿墙路径。',
  },
  {
    id: 'noUTurn',
    title: '反向剪枝',
    subtitle: '禁止 180° 反向，路径不来回折返',
    group: 'constraint',
    kind: 'toggle',
    icon: 'uturn',
    accent: '#8f5540',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: false,
    formula: 'Δθ ≠ 180°',
    compiles: '硬约束 · 禁止反向',
    visual: '去掉回折线段',
    detail:
      '在带朝向的搜索状态中剪掉 180° 反向，适合走廊、单车通道这类掉头代价高的场景。',
  },
  {
    id: 'maxTurn',
    title: '最大转角',
    subtitle: '单步转向不超过设定角度',
    group: 'constraint',
    kind: 'angle',
    icon: 'angle',
    accent: '#8f5540',
    defaultEnabled: false,
    defaultValue: 90,
    defaultInRecipe: false,
    min: 45,
    max: 180,
    step: 45,
    unit: '°',
    formula: 'Δθ ≤ θ_max',
    compiles: '硬约束 · 最大转角',
    visual: '急弯处直接断开',
    detail:
      '硬约束。限制到 45° 时路径更顺，但窄门或凹槽可能直接无解，界面会明确显示不可行。',
  },
  {
    id: 'budget',
    title: '扩展预算',
    subtitle: '扩展节点超过上限就停止',
    group: 'constraint',
    kind: 'budget',
    icon: 'target',
    accent: '#8f5540',
    defaultEnabled: false,
    defaultValue: 12000,
    defaultInRecipe: false,
    min: 1000,
    max: 30000,
    step: 1000,
    unit: '节点',
    formula: 'expanded ≤ N_max',
    compiles: '硬约束 · 搜索预算',
    visual: '超过预算后停止扩展',
    detail:
      '搜索每展开一个状态就计数，超过上限直接判定本轮失败。用来观察“预算不够时，算法会停在哪里”。',
  },  {
    id: 'smooth',
    title: '可见性剪枝',
    subtitle: '桥接：去掉折线里不必要的拐点',
    group: 'bridge',
    kind: 'toggle',
    icon: 'smooth',
    accent: '#5c6560',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: true,
    formula: 'path ← lineOfSight(path)',
    compiles: '桥接 · 可见性剪枝',
    visual: '折线变少 · 路径更直',
    detail:
      '只做几何拉直，不引入动力学；拉直后会重新计算长度、最小间隙和代价，数据仍来自最终路径。',
  },
  {
    id: 'round',
    title: 'Chaikin 平滑',
    subtitle: '桥接：把折角磨圆，路径更连续',
    group: 'bridge',
    kind: 'toggle',
    icon: 'round',
    accent: '#5c6560',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: false,
    formula: 'path ← chaikin(path)',
    compiles: '桥接 · 角点圆滑',
    visual: '折角变成小弧线',
    detail:
      '用 Chaikin 切角做两轮平滑，并逐段做碰撞检查；不通过时回退到平滑前路径。它只改变几何形态，不改变搜索代价。',
  },
  {
    id: 'simplify',
    title: '路径抽稀',
    subtitle: '去掉近共线点，只保留关键拐点',
    group: 'bridge',
    kind: 'toggle',
    icon: 'route',
    accent: '#5c6560',
    defaultEnabled: false,
    defaultValue: 1,
    defaultInRecipe: false,
    formula: 'path ← simplify(path)',
    compiles: '桥接 · RDP 抽稀',
    visual: '路径点变少',
    detail:
      '用 Ramer–Douglas–Peucker 去掉近共线的中间点，再做线段碰撞检查；不通过就保留原路径。',
  },]

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

export function cardValueLabel(card: CardDef, value: number): string {
  if (card.kind === 'toggle') return value > 0 ? '开' : '关'
  if (card.kind === 'radius') return `${value.toFixed(2)} 格`
  if (card.kind === 'angle') return `${value.toFixed(0)}°`
  if (card.kind === 'budget') return `${Math.round(value)} 节点`
  if (card.kind === 'choice') {
    return card.options?.[Math.round(value)] ?? `${value}`
  }
  return `${value.toFixed(2)}×`
}