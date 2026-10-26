# 交接：EGO-Planner 科普片 + Pathcraft 接入 + 3D 拖动再打磨

> 交接时间：2026-10-26 22:15（Asia/Shanghai）
> 上一份交接（`HANDOFF-3D-CARDS-FLOW.md`）里的六件事**已全部落地并发版 0.10.0**，本文件取代它。
> 本轮目标：一支 EGO-Planner 科普片、把 EGO-Planner 真的做进 Pathcraft、再把 3D 拖动打磨一版。

---

## 0. 可直接复制的续接提示词

```
继续 Pathcraft（D:\Vibe）的下一轮。这次三件事，顺序很重要：先把算法做进产品，再拍片，最后打磨交互。

开工前必读（按顺序，不要跳）：
1. D:\Vibe\HANDOFF-EGO-PLANNER.md        ← 本文件，任务与做法
2. D:\Vibe\promo\AST-PLAYBOOK.md         ← 上一支片子沉淀的方法与全部坑，必须完全照做
3. D:\Vibe\promo\AST-FILM-V3.md          ← 字幕系统 / 机位铁律 / 逐轮改法的来源
4. D:\Vibe\promo\AST-COPY.md             ← 标题、简介、封面的写法

三件事：
A. 给 Pathcraft 加 EGO-Planner（gradient-based，B 样条 + 逃逸方向 + 时间重分配），
   要真的能跑、能拖点、能进流程回放，并导出画面要用的一切数字（JSON）。
B. 拍一支 ~100 秒的 EGO-Planner 科普片。核心不是"讲清楚"，是让观众喊"这也行？"。
   三个"妙"的节拍见 §2.2，必须按它剪。
C. 3D 地图形变/拖动/视角再打磨一版，见 §4。

硬约束（违反任何一条都算失败）：
- 片子里每一个数字都必须由 A 的脚本跑出来，不许从论文抄、不许手填；
  要引用论文数字时，画面上必须明确标"论文报的"。
- 字幕 5.6–6.0 字/秒，单句不超 6.9；每句一个可验证的事实；幕首不用"它"。
- 每个视觉世界 4–8 秒；每个镜头都在动，静止超 1.5 秒就剪掉或加推轨。
- 推送只能走 promo/tools/push_api_range.py（本机 443 到 github.com 被墙）；promo/ 不进仓库。
- 改完必须过：npx tsc --noEmit、npx vite build、npx tsx scripts/world3d.ts、npx tsx scripts/check.ts、
  npx tsx scripts/pick.ts、npx tsx scripts/cards.ts。2D 基准 46.56 / 31.00 / 46.21 不许变。
```

---

## 1. 进度快照（22:15）

### 1.1 产品线：0.10.0 已上线，本轮从干净状态起步

| 项 | 值 |
|---|---|
| 提交 | `7aa166d Release 0.10.0: point where you drop, and seven knobs that matter` |
| 版本 | `0.10.0`，`main` 与 `origin/main` 同 sha，tag `v0.10.0`，Release 已发，Pages 已部署 |
| 新增回归 | `scripts/pick.ts`（相机往返 2,652 格 × 6 层，误差 1.4e-14）、`scripts/cards.ts`（参数卡是否真生效） |
| 卡片 | 19 → **26** 张（新增采样步长 / 目标偏置 / 重连半径 / PRM 连边半径 / 信息素挥发 / 启发指数 β / 变异率） |
| 求解器 | 17 个：astar dijkstra greedy bfs dfs weighted rrt rrtstar prm visibility jps ida bidirectional beam dstar aco ga |

0.10.0 做完的事（别重复做）：三维投影反解补齐 `Z_LIFT`、标记画在落点上并逐格缓动、
轨道转视角改目标值+缓动、惯性时间窗估速、滚轮朝光标缩放、流程区重排+逐行点亮、README 动图重录。

### 1.2 视频线：**管线已经换代，不要用旧的 beat3 那套**

这一点最容易搞错。做 A\* 片时整条管线换掉了：

```
旧（宣传片 beat3）：Playwright 逐帧截真实 UI → Python 算机位 → ffmpeg 合成
新（A* 片）：单文件 HTML（three.js + GSAP）+ 一个时钟 renderAt(t) → hyperframes 逐帧渲染 → ffmpeg 混音
```

| 产物 | 路径 |
|---|---|
| 成片 | `promo/edit/ast-101s-final.mp4`（101.30 s / 1920×1080 / 30 fps / 87.3 MB） |
| 唯一工程文件 | `promo/_hf/ast3d/index.html`（167 KB，含字幕系统与全部世界） |
| 混音 | `promo/_hf/ast3d/mix5.sh`（BGM + 23 个事件，按画面时间 adelay） |
| 依赖 | `promo/_hf/`（hyperframes 0.8.201 + three 0.169 + gsap，已装） |
| 数据导出 | `promo/tools/dump_home.ts` / `dump_map.ts` / `dump_route.ts` / `dump_events.ts` |
| 封面 | `promo/_cover/make.py`（Pillow，直接取正片帧） |
| 分镜与逐轮改法 | `promo/AST-FILM-V3.md` |
| 方法与坑 | `promo/AST-PLAYBOOK.md` ← **必须完全照做** |

`promo/` 整个目录在 `.git/info/exclude`，不进仓库，但它是发版与推送脚本的依赖，删不得。

---

## 2. 任务一：EGO-Planner 科普片

### 2.1 先把事实钉死（以下已核对，可直接用）

**论文**：*EGO-Planner: An ESDF-Free Gradient-Based Local Planner for Quadrotors*
Xin Zhou, Zhepei Wang, Hongkai Ye, Chao Xu, Fei Gao（浙大 FAST Lab）
IEEE RA-L 2021, Vol.6 pp.478–485，DOI `10.1109/LRA.2020.3047728`，arXiv `2008.08835`
代码：`github.com/ZJU-FAST-Lab/ego-planner`（C++/ROS）；后继是 EGO-Swarm。

**它到底干了什么（一句话）**：
梯度类规划器需要知道"每个点离障碍多远、往哪躲"，教科书的做法是预计算一整张 ESDF；
EGO-Planner 把"往哪躲"换成一个便宜的问题——**只对已经撞进障碍的那几个控制点，
找一条无碰撞引导路径上的最近点 g，梯度直接用 q−g**。不必建场。

**数学骨架**（照论文，别自己编）：

```
轨迹：均匀 B 样条，控制点 Q = {Q_0 … Q_n}，时间间隔 Δt
      V_i = (Q_{i+1} − Q_i) / Δt
      A_i = (V_{i+1} − V_i) / Δt
      J_i = (A_{i+1} − A_i) / Δt

总代价：J = λ_s·J_s + λ_c·J_c + λ_d·J_d

平滑：  J_s = Σ‖A_i‖² + Σ‖J_i‖²
碰撞：  J_c(q_i) = ½‖q_i − g_i‖²      ∇J_c = q_i − g_i
        g_i = 无碰撞引导路径上距 q_i 最近的点（只在 q_i 真的卡住时才算）
        安全间距 s_f，d_ij = 距离，c_ij = d_ij − s_f
可行：  J_d 用「时间重分配」在梯度循环外解决——速度/加速度超限就把 Δt 按
        max(‖v_i‖/v_max, ‖a_i‖/a_max) 拉长，形状不变；再用各向异性曲线拟合调高阶导
优化器：L-BFGS
```

**性能口径（要分清是谁的数字）**：论文/仓库报的是"整次规划约 1 ms，重规划周期 2–6 ms（i7 第八代 NUC）"。
这句话**不能**和 Pathcraft 实测数字放进同一套视觉语言里。片子里如果要出现 ms，
必须是从 Pathcraft 的 EGO 实现跑出来的数，或者明确打上"论文报的"标签。

**一个必须自己查证的细节**：网上二手资料常写"五次 B 样条给 C² 连续"，这是错的
（p 次 B 样条是 C^{p−1}，三次就是 C²，五次是 C⁴）。ego-planner 代码里默认是
`BSPLINE_ORDER = 3`。**上画面前去仓库/论文核对，别抄二手博客。**

### 2.2 这支片子怎么才能让人喊"很妙"

思想确实不复杂：**别建整张场，只问卡住的那几个点**。所以片子不能靠"讲得清楚"取胜——
清楚只会让人点头，不会让人叫好。要叫好，必须**先让观众坚信某件事是必须的，再当场推翻它**。

三个节拍，每个都是"设套 → 拆穿"，缺一个就平：

| 节拍 | 先让观众相信（设套） | 然后推翻（拆穿） | 画面怎么翻 |
|---|---|---|---|
| **一 · 不必算整张场** | ESDF 那一套是必须的：把整间房切成体素，逐格算距离，一格一格亮起来，**要看完它算完**（约 8 秒，别省） | 这条曲线只经过其中三百来格；真正卡住的只有 3 个点 | 全场亮完 → 只留下曲线穿过的一条"走廊" → 再缩到 3 个红点。数字阶梯 **128,000 → 312 → 3** |
| **二 · 不需要真的梯度，只需要方向** | 梯度得是精确的：画一张漂亮的等高线地形图，箭头处处垂直于等高线 | 优化只要一个"下坡方向"。所以找人拽一把就够了——从障碍里拽出一条逃逸箭头，点被推出去，曲线自己弹开 | 等高线图碎掉，换成"雾里下坡"的意象：只看得见脚尖往哪边低 |
| **三 · 不改路线，改时间** | 飞太快了 → 应该重规划一条更缓的路 | 路线没错，是时间错了：同一条曲线，把 Δt 拉长，速度箭头集体变短，路线一格没动 | 曲线**保持不动**，时间轴被拉长，速度矢量缩短——反直觉的点在于"动的是尺子不是画" |

第三拍是"妙"的保险：观众被前两拍训练出"要改路线"的惯性，第三拍偏不改。留一句：
**"它动的不是路，是表。"**

**贯穿全片的一个数字母题**：`128,000 → 312 → 3`。
这个塌陷本身就是爽点，字幕只说人话（"整间房" / "这条曲线" / "三个点"），数字交给画面滚。
参考 A\* 片里 `2029 / 865 / 64` 的做法：数字用 Georgia、等宽、`data-count` 从 0 滚上去、**句末前滚完**。

**一条硬规则：字幕说人话，画面做怪事。**
不要把"巧"写进字幕。字幕越平，画面越怪，观众越会自己得出"这也行？"。
反例（不要写）："EGO-Planner 巧妙地避免了 ESDF 的冗余计算。"
正例（可用）："它没算那张表。／它只问了三个点：往哪躲。"

**每幕的第一句先承接上一幕的结论，再提问**（这是这位用户反复强调过的规矩，A\* 片也是这么写的）：
- "整间房算完了。／可它只走过其中一条走廊。"
- "方向对了就行。／那这个方向，凭什么可信？"
- "路线没动。／那它改了什么？"

### 2.3 分镜骨架（10 个世界，可直接开写，但先按 §2.2 校一遍）

| # | 时间 | 世界 | 画面要点 | 这一幕要落下的事实 |
|---|---|---|---|---|
| 01 | 0–9 | 黑场 → 仓库/树林 | 一条曲线画出 → 硬切贴地跟拍无人机 → **撞**（挤压 + 62 Hz 抖动 + 低频撞击） | 它只有局部地图，前面三米 |
| 02 | 9–19 | 体素房间（俯视） | ESDF 逐格点亮，整间房铺满；数字滚到 128,000 | 教科书的办法：先把整个空间算成距离表 |
| 03 | 19–27 | 同一房间，只留走廊 | 全场褪去，只留曲线穿过的窄带；数字塌到 312 | 这条曲线只碰过一小部分 |
| 04 | 27–36 | 控制点特写 | 曲线上的控制点变成小方块，3 个变红；镜头推近 | 真正卡住的只有 3 个 |
| 05 | 36–46 | 同一 3 个点 | 从障碍里拉出逃逸箭头 → 点被推出去 → 曲线**弹开**（要看到"弹"） | 它只问：往哪躲 |
| 06 | 46–56 | 桌面图纸 | 三张卡：平滑 / 别撞 / 别超速（照 A\* 片的 g/h/f 三卡做法，卡片要避让，别压字） | 整个方法就是三个代价相加 |
| 07 | 56–66 | 同一条曲线 + 时间轴 | 曲线不动，时间轴拉长，速度箭头变短 | 它动的不是路，是表 |
| 08 | 66–76 | 对比 | 左：整场重算（慢）；右：只算卡住的点（快）。数字必须自己跑的 | 差在"算了什么"，不在"算得多好" |
| 09 | 76–88 | 应用 | 穿越机 / 集群（EGO-Swarm）/ 送货；每个 4 秒，都在动 | 这些地方都在用同一个偷懒 |
| 10 | 88–101 | 项目 + 片尾 | Pathcraft 真实录屏（EGO 卡片、拖点、曲线被推开）+ 片尾卡 + 开源地址 | 这些步骤做成了一个能拖点的网页 |

写分镜时逐条对照 `AST-FILM-V3.md` §四/§五：产品段要用真实录屏按 15 fps 拆帧播放，
窗口 1400×788 圆角 6 px，顶部段名 + 进度条；机位不超过房间边界（`AST-PLAYBOOK.md` §4 有夹紧公式）。

### 2.4 用法（照抄，别自创）

```bash
cd /d/Vibe/promo/_hf
export PATH="/c/Users/12467/.workbuddy/tools/ffmpeg/bin:$PATH"

# 新建一集：复制 ast3d 当底稿（字幕系统、时间表、换场 wipe 全部保留）
cp -r ast3d ego3d

# 静帧审查（改之前先看，不要边改边渲）
npx hyperframes snapshot ego3d --at 3.1,10.2,28.5 --no-end -o ego3d/renders/snap
npx hyperframes snapshot ego3d --at 40 --zoom 'x,y,w,h' -o ego3d/renders/snap   # 放大看局部

# 全帧渲染（1080p30，100 s ≈ 3 分钟）
npx hyperframes render ego3d -o renders/ego.mp4

# 混音：改 mix5.sh 的事件表（时间全部相对 T.*，绝对数字只留在开场）
```

时间轴纪律（`AST-PLAYBOOK.md` §2）：**所有动画时间写成 `T.段名 + 偏移`**，
整体缩放时改 `T` 表 + 用分段线性映射搬字幕时间，再用 Python 逐句量 `字数/秒数`。

### 2.5 验收（片子）

- [ ] 抽 20+ 帧拼图逐格看：空镜 / 穿模 / 字幕不可读 / 构图失败
- [ ] 每句 `字数/秒数` ≤ 6.6，平均 5.6–6.0；相邻句不重叠；最后一句在片尾卡前收干净
- [ ] 三个"妙"的节拍都在，且**每次翻面都有 1 秒以上的"让观众自己反应"的空档**（不要用字幕填满）
- [ ] 数字阶梯 128,000 → 312 → 3 在画面上真的塌陷了一次
- [ ] `volumedetect` 峰值 < −1 dB；`alimiter=limit=0.79:level=0:attack=5:release=60`
- [ ] 每个世界边界有 wipe，且 wipe 与混音 whoosh 对齐
- [ ] 封面直接取正片帧（`promo/_cover/make.py`），标题见 §2.6

### 2.6 标题方向（照 `AST-COPY.md` 的钩子结构：与我有关 + 反差 + 具体数字）

- 主推：**「为了躲一根柱子，它算了整间房——然后发现只要 3 个点」**
- 备选：`它没有地图，只有三个问题` / `把整座山的地图撕了，只留脚尖` / `1 毫秒的偷懒：EGO-Planner`
- 抖音（前三字定生死）：`无人机躲树，靠的是偷懒`

---

## 3. 任务二：把 EGO-Planner 做进 Pathcraft

### 3.1 为什么它在这个项目里成立

现有 17 个求解器分两族：**搜格子**（astar/jps/dstar…）与**撒点**（rrt/rrtstar/prm/visibility）。
EGO 是第三族：**优化一条曲线**。它也是第一个"天然属于 3D"的规划器
（无人机就是三维的），所以它应该进 `SPATIAL_SOLVERS`，在体素和连续场里都能跑。
这一点值得在 README 与片子里说清楚：**不是又一个搜索算法，是另一种范式。**

### 3.2 接入点（一处不漏）

| 文件 | 改什么 |
|---|---|
| `src/lib/types.ts` | `TraceKind` 加 `'gradient'`；`PlanResult.reason` 可能要用 `'unsupported'` |
| `src/lib/solvers/registry.ts` | `SolverId` 加 `'ego'`；`SolverSpec` 新增一条（`value: 17`，`continuous: true`，`costModel: 'distance'`，`heavy: false`）；`SPATIAL_SOLVERS` 加 `'ego'`；`STRATEGY_GROUPS` 若要新族则加一条 |
| `src/lib/solvers/ego.ts` | 新建：B 样条 + 三项代价 + 逃逸方向 + 时间重分配 + 优化器 |
| `src/lib/solvers/index.ts` | `solveWith` 加 `case 'ego'`（2D 走 GridMap 版） |
| `src/hooks/useWorldPlan.ts` | `planSpatial()` 加 ego 分支（3D 走 World 版） |
| `src/lib/cards.ts` + `types.ts` `CardId` | 新增 2–3 张真参数卡（见 3.4） |
| `src/lib/i18n.tsx` | 中英文案；`src/components/Icon.tsx` 可能要补图标 |
| `src/components/FlowPanel.tsx` | 不必大改：`isGraph = !trace || trace.kind === 'graph'`，非 graph 分支直接用 `trace.init` + `trace.loopLabel` |

### 3.3 实现要点

**结构**：把"碰撞查询"抽成一个维度无关的接口，核心优化器只认坐标。

```ts
interface Oracle {
  dim: 2 | 3
  /** 该点是否在可行域内（已含安全膨胀） */
  free(p: Vec3): boolean
  /** 从 p 出发找最近的可行点；找不到返回 null。这就是 g_i 的来源 */
  nearestFree(p: Vec3): Vec3 | null
  bounds: { min: Vec3; max: Vec3 }
}
```

- 2D 用 `GridMap.cells/clearance`；3D 用体素 `cells` 或场 `fieldDistance`（`snapOnLayer` 里已有两种的写法，直接抄它的判定口径，别另立一套）。
- **B 样条**：均匀三次，`n` 个控制点，`Δt` 初值取路径长度 / 期望速度；求值用 de Boor 或直接展开基函数。
- **初始化**：先用廉价方式给一条初始曲线（推荐：直接调现成的 `searchLattice` 得到折线，再当控制点粗取），
  这是"EGO 需要一个初始轨迹"的诚实实现，也顺便让流程面板的 init 段有东西可写。
- **J_c 的 g_i**：只在 `!free(q_i)` 时算；`nearestFree` 用当前的局部搜索（半径逐步放大），**不要**预建整张距离场
  ——那正是这个方法反对的东西，也必须让 `scripts/` 的能量测出来差别。
- **J_d**：梯度循环外做时间重分配（`Δt *= max(‖v‖/v_max, ‖a‖/a_max)`），再按论文做一次形状保持的高阶导调整；
  简版可以只做 Δt 缩放，但**要在代码注释与 UI 里说清楚"这里做了简化"**——这个项目不允许假装完整实现。
- **优化器**：L-BFGS（10 组历史）或带去回首的梯度下降。TS 里两百行足够，不要引依赖。
- **结果**：`path3` 放采样后的平滑曲线（密点）；`events` 放每次迭代的记录
  （`x/y/z` 取当前曲线中点，`g/h/f` 借位放 `J_s/J_c/J_d`），这样流程面板的播放和高亮能直接用；
  `trace.kind = 'gradient'`，`trace.init` 写 B 样条与控制点数量，`trace.loopLabel` 写 `L-BFGS`。
  参考 `sampling.ts` 是怎么在没有"扩展"这个概念的情况下填 `events` 的——照它的做法，别自创。
- **`note`**：如果某张卡对它无效（转角、掉头、最大转角、切角这些格子语义的卡），写进 `ignores`，
  UI 会自动标"不适用"。

### 3.4 参数卡（必须真的改变结果）

0.10.0 已经因为"旋钮不动"删掉过两张卡，这一条是硬门槛。

| 卡 | 参数 | 为什么它真的会变 |
|---|---|---|
| **安全间距** | `s_f` | 直接改 `c_ij = d_ij − s_f`，路径离墙的距离肉眼可见地变 |
| **平滑权重** | `λ_s` | 与 `λ_c` 的比例决定"贴墙抄近路"还是"绕远换平顺" |
| **最大速度** | `v_max` | 时间重分配的唯一开关：调小 → Δt 变长 → 同一条曲线的速度箭头整体变短 |

每张都要在 `scripts/cards.ts` 里加三档取值的断言（固定种子、结果必须不同），
并写进 CHANGELOG 的表格——那已经是本项目的惯例。

### 3.5 验收（代码）

- `npx tsx scripts/world3d.ts` 全 PASS，2D 三个数（46.56 / 31.00 / 46.21）不动
- 新增 `scripts/ego.ts`：固定种子跑到收敛，输出 `J_s / J_c / J_d / 迭代次数 / 耗时 / 控制点数`
  ——**这份输出就是片子的数据源**，导出 JSON 给 `promo/_hf/ego3d/`
- 浏览器里：3D 停机棚 + EGO，拖 S，曲线实时跟着弯；切换安全间距，路径明显让开
- 流程面板：`gradient` 类型的 init / loop 文案正常，播放逐行点亮

---

## 4. 任务三：3D 拖动与视角再打磨

0.10.0 已经修了投影反解（`Z_LIFT`）、标记画在落点上并缓动、轨道缓动、惯性、朝光标缩放。
所以这轮**不要重做**，先量、再只改还没解决的部分。

### 4.1 先量（三个数，量完再决定改什么）

```
1. 视角差：拖到墙上，标记像素位置 − 光标像素位置（0.10.0 是 4.0 px；> 12 px 才算问题）
2. 滑动距离：拖过一根柱子时，锚点最多离开手指几格（现在 SLIDE_CELLS = 3，约 57 px）
3. 俯角敏感度：pitch 从 0.86 压到 0.20 时，竖直拖 100 px 对应的世界位移（理想 < 1.6 倍）
```

### 4.2 四个候选改法（按性价比排序）

1. **给一个顶视**（最推荐）。这是"透视里拖点必然错位"的唯一诚实解法：
   放置时按 **Shift**（或点一个按钮）临时把 pitch 拉到 π/2，画面变成正俯视，
   `1/sin(pitch)` = 1，屏幕坐标和地图坐标一一对应，松手回到原角度。
   Pathcraft 是路径规划工具，顶视本来就是它的"工作视角"。
2. **把滑动半径从 3 格收到 1–2 格**，并且优先沿墙面**法向**滑，而不是在环形邻域里找最近空格
   （现在可能滑到墙的另一侧，观感就是"跳到别处"）。
3. **抓取偏移**：按下时记住"手指相对标记的偏移"，拖动时按增量移动，而不是把标记拽到光标正下方。
   现在是后者，所以一抓就跳半个格。
4. **方向键微调**：选中端点后 ←→↑↓ 移动一格（Shift 加速）。透视下手拖永远不可能精确到格，
   键盘是唯一的补丁，成本很低。

### 4.3 验收

一个 Playwright 脚本跑完上面三个数，前后对比写进 CHANGELOG；
外加"顶视放置"的截图，证明屏幕点与格心一一对应。

---

## 5. 坑表（按来源分，全部踩过）

### 5.1 视频 / HyperFrames（来自 `AST-PLAYBOOK.md`，逐条都别踩）

| 坑 | 现象 | 解法 |
|---|---|---|
| ffmpeg 不在 PATH | `render` 失败且报错不提 ffmpeg | 先 `export PATH="/c/Users/12467/.workbuddy/tools/ffmpeg/bin:$PATH"` |
| `nohup ... &` 起渲染 | shell 退出进程被杀 | 用后台任务，不要 nohup |
| 容器级 `filter: blur()` | **截图里整个元素不出现** | 衬底/柔光一律用 `box-shadow` 或多层渐变 |
| `z-index: -1` | 被父级不透明背景吃掉 | 给父元素 `isolation: isolate` |
| three.js 用 `../` importmap | 整屏黑 | 复制进工程目录，用 `./vendor/` |
| `InstancedMesh.scale` | 连实例位置一起缩放 | 改 geometry |
| `scale 0` 隐藏实例 | 渲染成亮像素 | 用 `count` / `visible` |
| 俯视镜头 | 画面翻转/抖动 | `camera.up = (0,0,-1)` |
| 跟拍机位 | 相机跑进墙里，画面是白墙 | 先夹紧：`x = max(rx − 1.05, −4.02)` |
| `alimiter` 默认 `level=1` | 归一化到 0 dB 削顶 | `alimiter=limit=0.79:level=0:attack=5:release=60` |
| 字幕用 GSAP 补间控 opacity | 逐帧捕获里滞后 | 一律在 `renderAt` 里按 t 直写 |
| 两条路完全重合 | 细的那条整颗埋进粗的 | **重合只能靠"宽度"表达**：宽带 + 压在上面的窄带 |
| 小物件远景 | 5 cm 珠子只有 3 px | 换景别或换表达（宽度/数字），别放大物体 |

### 5.2 我自己的手误（每次都栽）

1. **批量 `str.replace` 必须 `assert a in s`**。静默失败过两次：一次整段 CSS 没进去（画面浮在纯黑），一次锚点没匹配。
2. **带捕获组的正则，替换串只能用 `group`**，不要手写正文——曾把一句字幕拼成两遍。
3. **负数的非整数次幂在 Python 里是复数**，`max()` 直接 TypeError（渐变 scrim 的指数要防护）。
4. 改时间轴前先 `cp index.html index.html.bak`。

### 5.3 代码 / 环境

1. `git push` 到不了 github.com（443 被墙，schannel/openssl 都试过，ssh 无 key）；走 `promo/tools/push_api_range.py --apply`，每次发版记得在它的 `TAGS` 里加新标签。
2. `pack_release.py` 只打 `git ls-files` 的跟踪文件；`promo/` 与 `.tmp-ui/` 不能进包。
3. 沙箱拦 `shutil.rmtree`，删目录走 `cmd /c rd /s /q`。
4. 暗色主题：`[data-theme="dark"]` 必须覆盖亮色稿里的**硬编码**颜色（`::selection`、滚动条、开关、toast、chip 边框）。
5. 3D 求解实测：体素 45–56 ms/次，连续场 8 ms/次。注释里的"70–160 ms"是旧的估值，别再引用。
6. `snapOnLayer` 返回 `null` 表示"这一层没有合法格"，不是坐标 0。
7. 2D 基准 46.56 / 31.00 / 46.21 —— 变了就是碰了求解器。

---

## 6. 环境与命令速查

```
项目根      D:\Vibe
python      D:\Python\python.exe
ffmpeg      C:\Users\12467\.workbuddy\tools\ffmpeg\bin\ffmpeg.exe
视频工程    D:\Vibe\promo\_hf\   （hyperframes 0.8.201，命令都在这个目录下跑）

回归（全过才算完）
  npx tsc --noEmit
  npx vite build
  npx tsx scripts/world3d.ts
  npx tsx scripts/check.ts
  npx tsx scripts/pick.ts
  npx tsx scripts/cards.ts
  npx tsx scripts/ego.ts        ← 本轮新增

本地起服务（Playwright 验证/录屏）
  npx vite --port 5179 --host 127.0.0.1

发版
  npx vite build --config vite.bundle.config.ts && node scripts/package.mjs --classic
  D:/Python/python.exe promo/tools/pack_release.py
  git tag v0.X.0 HEAD
  D:/Python/python.exe promo/tools/push_api_range.py --apply
  git update-ref refs/remotes/origin/main <远端 sha>
  D:/Python/python.exe promo/tools/make_release.py --tag v0.X.0 --name "…" --apply
```

---

## 7. 建议顺序

1. **先把 EGO 做进 Pathcraft**（§3）。片子要的数字、要的录屏、要的"卡片"全依赖它。
   没有真实现，片子就只能讲论文——而讲论文的片子，观众不会喊"妙"。
2. **导出 JSON，定死三个数字**（128,000 / 312 / 3 这几个量级要按真实实现重算，别硬套）。
3. **按 §2.2 写字幕与分镜**，写完先量字数/秒数，再动手做画面。
4. **复制 ast3d 起工程**，一个世界一个世界做，每 4–8 秒一个，做完就 snapshot。
5. **整片渲染 → 混音 → 抽帧复盘**，循环到 §2.5 全绿。
6. **3D 拖动打磨**（§4）放在片子之后：它只影响产品段那几秒录屏，可以最后补录。
7. 发版 0.11.0（EGO + 拖动打磨），片子和 Release 一起对外。
