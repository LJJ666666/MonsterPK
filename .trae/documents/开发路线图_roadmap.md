# 幻兽收集 RPG - 路线图与任务跟踪 (Roadmap)

本文档用于记录“已完成 / 未完成 / 后续规划”，并把每个模块落到可追踪的代码入口，方便持续扩充内容（技能/幻兽/机制/UI）与移动端打包（Capacitor/Android）。

## ✅ 已完成（可用的 MVP 基座）

### 1) 存档与数据驱动
- [x] 自动存档（localStorage）+ 导入/导出：入口 [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)、[Start.tsx](file:///workspace/src/pages/Start.tsx)
- [x] 核心数据类型：怪物/技能/道具/战斗结构 [types.ts](file:///workspace/src/game/types.ts)
- [x] 静态内容库：幻兽、技能、主题遭遇、道具等 [data.ts](file:///workspace/src/game/data.ts)

### 2) 回合制战斗（核心循环已打通）
- [x] 回合流程、速度、优先度、命中/闪避、能力阶、状态结算、暴击/多段等：入口 [rules.ts](file:///workspace/src/game/rules.ts)、战斗页 [Arena.tsx](file:///workspace/src/pages/Arena.tsx)
- [x] 战斗内背包与捕获入口（可用道具、可捕获并入库/入队）：入口 [Arena.tsx](file:///workspace/src/pages/Arena.tsx)、store [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)

### 3) 技能系统（可扩展）
- [x] MoveSpec 数据结构可持续扩展（teachable/exclusive/target/status/statChanges/crit/multiHit/desc 等）：[types.ts](file:///workspace/src/game/types.ts)
- [x] 24 属性技能库扩充与图鉴展示：数据 [data.ts](file:///workspace/src/game/data.ts)、弹窗 [MoveChartModal.tsx](file:///workspace/src/components/MoveChartModal.tsx)
- [x] 机制说明（概率档位、状态解释、规则说明等）并适配移动端宽度：弹窗 [MechanicsModal.tsx](file:///workspace/src/components/MechanicsModal.tsx)
- [x] 升级学技能（超过 4 招触发替换/放弃）：弹窗 [MoveLearnerModal.tsx](file:///workspace/src/components/MoveLearnerModal.tsx)

### 4) 图鉴与“防剧透”展示
- [x] 图鉴顺序（dexNum）+ 未发现显示 ??? + 已发现/已捕获统计 + 模糊搜索（??? 不参与）：页面 [Camp.tsx](file:///workspace/src/pages/Camp.tsx)、数据 [data.ts](file:///workspace/src/game/data.ts)

### 5) 进化系统（谨慎版、可扩展）
- [x] 进化链配置（按等级条件）与 pendingEvolution 触发：数据 [data.ts](file:///workspace/src/game/data.ts)、规则 [rules.ts](file:///workspace/src/game/rules.ts)
- [x] 安全进化结算（保留个体差异、按等级重算面板、HP 按比例继承）：[evolveMonsterInstance](file:///workspace/src/game/rules.ts)
- [x] 弹窗确认 & 顺序保证“先学技能，再进化”：弹窗 [EvolutionModal.tsx](file:///workspace/src/components/EvolutionModal.tsx)、挂载 [App.tsx](file:///workspace/src/App.tsx)

### 6) 移动端体验与 Android 打包链路
- [x] 状态栏/刘海区域沉浸体验（Capacitor StatusBar）：依赖 [package.json](file:///workspace/package.json)、原生目录 /workspace/android
- [x] 云端打包 APK 记录：见 [apk_build_guide.md](file:///workspace/apk_build_guide.md)

---

## 🔄 未完成（下一阶段优先级）

### P0：核心循环打磨（优先做“可玩”和“可长期扩充”）
- [ ] 捕获率公式与摇晃反馈更精细化（血量/状态/装置/稀有度）：规则入口 [rules.ts](file:///workspace/src/game/rules.ts)、道具 [data.ts](file:///workspace/src/game/data.ts)
- [ ] 战斗内“换位 / 逃跑 / 道具分类”交互完善（避免误触、移动端可达性）：入口 [Arena.tsx](file:///workspace/src/pages/Arena.tsx)
- [ ] 存档版本迁移策略固化（每次新增持久化字段都能平滑升级）：入口 [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)

### P1：内容增长（优先补“可收集规模”和“差异化配置入口”）
- [ ] 幻兽数量扩充（向 200 目标推进）：补齐 dexNum、栖息地、进化链、learnset：数据 [data.ts](file:///workspace/src/game/data.ts)
- [ ] Learnset 配置下沉：每只幻兽的“升级可学技能树”更明确（避免所有怪学同一套）：数据/规则入口 [data.ts](file:///workspace/src/game/data.ts)、[rules.ts](file:///workspace/src/game/rules.ts)
- [ ] 平衡性回合日志与数值校验（强度、PP、异常概率档位一致性）：规则入口 [rules.ts](file:///workspace/src/game/rules.ts)

### P2：进化扩展（在“谨慎不踩坑”前提下迭代）
- [ ] 道具进化（condition.type === "item"）全链路：背包使用 → 触发 pendingEvolution → 弹窗确认：入口 [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)、[EvolutionModal.tsx](file:///workspace/src/components/EvolutionModal.tsx)
- [ ] 分支进化与多条件（等级+道具/时间/亲密度等）：仅先设计数据结构与 UI 交互，规则逐步落地

---

## 🧭 后续规划（中长期）

- [ ] 训练师/NPC 连战与队伍 AI：入口 [Arena.tsx](file:///workspace/src/pages/Arena.tsx)、规则 [rules.ts](file:///workspace/src/game/rules.ts)
- [ ] 世界地图与区域事件（更明确的“收集驱动”）：页面扩展 [Camp.tsx](file:///workspace/src/pages/Camp.tsx)
- [ ] 成就/统计面板、收藏箱优化、筛选排序：store [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)
- [ ] 打包发布（Release、签名、版本号/渠道）：文档补强 [apk_build_guide.md](file:///workspace/apk_build_guide.md)

---

## 验收口径（建议）

- 每个新增模块必须满足：移动端单手可用、关键入口不超过 2 次点击、无横向滚动依赖（表格除外）
- 每次新增持久化字段必须：递增存档 version + migrate 兜底 + 老存档可继续玩
