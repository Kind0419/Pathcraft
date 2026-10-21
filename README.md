# Pathcraft

**An interactive, composable path-planning workbench.**  
用可组合卡片拼装路径规划算法，实时查看搜索过程、执行轨迹、最终路径与指标。

[中文](README.md) · [English](README.en.md)

[Live Demo](https://Kind0419.github.io/Pathcraft/) · [GitHub](https://github.com/Kind0419/Pathcraft) · [MIT License](LICENSE)

> Status: `0.4.0` · 2D grid · React + TypeScript + Canvas

[![Pathcraft interactive demo](https://Kind0419.github.io/Pathcraft/preview.gif?v=3)](https://Kind0419.github.io/Pathcraft/)

> GitHub 的 README 是静态 Markdown，不能直接运行这个应用。点击上面的 GIF，或打开 <https://Kind0419.github.io/Pathcraft/> 进入可交互版本。

---

## 这是什么

Pathcraft 是一个运行在浏览器里的 2D 栅格路径规划实验台。

它把路径规划拆成可组合的参数模块：

- **搜索**：A*、Dijkstra、贪心、BFS、DFS、加权 A*
- **代价**：间隙、转角、长度、斜向偏好、目标容差
- **约束**：安全膨胀、最大转角、禁止掉头、切角、扩展预算
- **后处理**：可见性拉直、Chaikin 平滑（轮数）、路径抽稀（容差）

在左侧组件库选择模块，右侧装配表调整数值，中间实时观察搜索波前、最终路径和上一版路径。流程页把当前回放帧映射到实际执行分支，并显示队列、扩展节点与卡片编译位点。

---

## 可以做什么

- 三个 2D 场景：凹槽、窄门、杂物场
- 2D 地图编辑：画墙 / 擦除 / 笔刷 1·3·5 / 清空 / 恢复预设
- 起终点点击与拖动；靠近障碍时沿安全边界滑动，并按格吸附到最近合法格
- 搜索回放：播放、暂停、时间轴、0.5x / 1x / 2x
- 搜索 / 路径 / 旧路径图层开关
- 画布 80%–105% 缩放；滚轮或 `− / +`
- 「专注」收起两侧面板，地图最大化
- 左 / 右 / 下三个面板可拖拽缩放，缩到阈值自动收起
- 装配行拖动排序、拖出取消、拖动期间禁止选中文字
- 组件库按搜索 / 代价 / 约束 / 后处理分组折叠，并显示参数符号
- 流程页：可拖动的装配链 + 实时执行轨迹（当前节点、g/h/f、开放集、实际分支）
- 悬停卡片时，流程中对应代码行与画布上的影响区域同步高亮
- 参数详情页扫描并显示可行区间；不连续可行域不会被误锁死
- 指标页：环形代价图 + 分段条 + 图例
- 无解时在底部指标条显示原因，并直接打开对应参数
- 分享 URL、导出 JSON / CSV
- 单文件离线版本
- 中文 / English 切换

### 执行轨迹

流程页不是静态示意图：它按当前回放帧高亮实际执行分支，右侧给出当前节点、g / h / f、开放集和扩展状态；下方的装配表可以拖动重排，悬停任意一行时画布会高亮该参数影响的区域。

![Pathcraft execution trace](https://Kind0419.github.io/Pathcraft/preview-flow.png?v=1)

---

## 算法范围

当前覆盖传统**图搜索主干**，通过「搜索策略」卡一键切换：

| 策略 | 优先级 |
|---|---|
| A* | `g + h` |
| 加权 A* | `g + 1.5h` |
| Dijkstra | `g` |
| 贪心最佳优先 | `h` |
| BFS | FIFO 入队顺序 |
| DFS | LIFO 出栈顺序 |

尚未接入：RRT / RRT* / PRM、D* Lite、JPS、IDA*、双向搜索、Beam、ACO、遗传算法。

---

## 快速开始

### 在线

<https://Kind0419.github.io/Pathcraft/>

### 本地

需要 Node.js >= 22.12 和 pnpm。

```bash
git clone https://github.com/Kind0419/Pathcraft.git
cd Pathcraft
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173/`。

### 检查、构建、单文件

```bash
pnpm typecheck
pnpm build
pnpm bundle
```

- `pnpm build`：类型检查 + Vite 构建，产物在 `dist/`
- `pnpm bundle`：生成 `release/Pathcraft.html`
- 单文件版本双击即可离线打开

---

## 项目结构

```text
src/
  App.tsx                 布局、状态、URL、拖拽、参数检查、导出
  styles.css              全部样式（单一设计系统）
  components/
    CanvasView.tsx        Canvas2D 绘制、命中、起终点、缩放、画笔
    Card.tsx              装配行、滑块、开关、choice chips
    FlowPanel.tsx         执行轨迹、卡片编译位点、流程拖拽
    Icon.tsx              线性图标
  lib/
    types.ts              公共类型
    cards.ts              16 张卡、参数符号、编译位点、默认值
    maps.ts               预设地图、clearance
    planner.ts            图搜索、策略优先级、代价、约束
    feasibility.ts        参数可行区间扫描
    i18n.tsx              中英双语文本与语言上下文
    heap.ts               MinHeap
scripts/
  check.ts                planner 冒烟检查
  package.mjs             单文件打包
```

---

## 贡献

欢迎开 Issue 或 PR。提交前至少运行：

```bash
pnpm typecheck
pnpm build
```

如果改了 planner，再运行：

```bash
pnpm exec tsx scripts/check.ts
```

---

## License

**MIT License** © 2026 Kind0419 · Pathcraft

你可以自由使用、修改、分发和商业使用。保留 [LICENSE](LICENSE) 中的版权声明与许可声明即可。

如果 Pathcraft 对你的项目有帮助，欢迎在文档中注明原作者 **Kind0419** 和项目 **Pathcraft**。