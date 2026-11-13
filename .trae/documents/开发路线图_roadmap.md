# 幻兽收集 RPG - 路线图与任务跟踪 (Roadmap)

> 更新于 2026-11-03（随 `2fc7439 加入技能 PP 与远征挂机系统` 同步）。本文档按「已完成 / 下一步 / 中长期」组织，并把每项落到可追踪的代码入口。  
> 关联文档：设计与可玩性分析见 [游戏设计分析\_可玩性补全.md](file:///workspace/.trae/documents/游戏设计分析_可玩性补全.md)，性能基线见 [性能基线\_web.md](file:///workspace/.trae/documents/性能基线_web.md)。

## 0. 当前进度快照

| 维度   | 现状                                                        |
| ---- | --------------------------------------------------------- |
| 核心循环 | 战斗 → 捕获 → 养成 → 收集 → 离线挂机 已闭环                              |
| 内容规模 | 幻兽 40 / 技能 294 / 道具 22 / 地点 7 / 野外区域 14 / 进化链 22          |
| 存档   | 服务端唯一真值（单档 + 行版本 CAS）；本地不保留任何副本（2026-11-13 起）              |
| 移动端  | 移动优先布局，Capacitor/Android 目录与打包文档齐备                        |
| 性能   | 冷启动 FCP ≈ 1.05 s（4x 降速 + Fast 3G），交互 < 50 ms，无长任务（详见性能基线） |
| 主要短板 | 缺少阶段目标（图鉴里程碑）、训练师战与携带道具，内容距 200 只仍有较大缺口                   |

---

## ✅ 已完成（可用的 MVP 基座）

### 1) 存档与数据驱动

- [x] 自动存档：已演进为**服务端唯一真值**（`GET/PUT /api/save` + 行版本 CAS）；早年的 localStorage 存档与 3 槽位已于 2026-11-13 删除
- [x] 核心数据类型：幻兽/技能/道具/战斗/地点 [types.ts](file:///workspace/src/game/types.ts)
- [x] 静态内容库：幻兽、技能、主题遭遇、道具、地点 [data.ts](file:///workspace/src/game/data.ts)

### 2) 回合制战斗

- [x] 伤害公式（等级因子、STAB 1.5、属性克制、0.85–1.0 浮动、暴击 1.5）：[rules.ts](file:///workspace/src/game/rules.ts)
- [x] 先制 priority、多段攻击、吸血、反伤、畏缩、能力阶（-6~+6）、命中/闪避阶
- [x] 异常状态：灼伤 / 麻痹 / 睡眠 / 中毒 / 冰冻，含行动判定与解除概率
- [x] 行动面板：技能 / 道具 / 换位（消耗回合）/ 逃跑（速度判定）
- [x] 战后结算：经验与金钱奖励，倒地自动换人，全灭回到恢复点
- [x] 战斗日志分区高亮（效果拔群 / 不理想）

### 3) 技能系统

- [x] MoveSpec 可扩展结构（target / status / statChanges / crit / multiHit / recoil / heal / flinch / **pp**）：[types.ts](file:///workspace/src/game/types.ts)
- [x] 294 个技能与图鉴展示：[MoveChartModal.tsx](file:///workspace/src/components/MoveChartModal.tsx)
- [x] 机制说明弹窗（概率档位、状态解释）并适配移动端：[MechanicsModal.tsx](file:///workspace/src/components/MechanicsModal.tsx)
- [x] 升级学技能，超过 4 招触发替换/放弃：[MoveLearnerModal.tsx](file:///workspace/src/components/MoveLearnerModal.tsx)

### 4) 图鉴

- [x] `dexNum` 顺序 + 未发现 `???` 占位 + 已发现/已捕获统计 + 名称模糊搜索（`???` 不参与）：[Camp.tsx](file:///workspace/src/pages/Camp.tsx)
- [x] 进化链内后续形态作为未知条目占位展示

### 5) 进化系统

- [x] 等级进化条件配置与 `pendingEvolution` 触发：[data.ts](file:///workspace/src/game/data.ts)、[rules.ts](file:///workspace/src/game/rules.ts)
- [x] 安全结算：属性按区间重映射保留个体差异、HP 按比例继承：[evolveMonsterInstance](file:///workspace/src/game/rules.ts)
- [x] 确认弹窗，且「先学技能、再进化」的顺序保证：[EvolutionModal.tsx](file:///workspace/src/components/EvolutionModal.tsx)、[App.tsx](file:///workspace/src/App.tsx)

### 6) 营地与地点

- [x] 队伍 / 背包 / 地图 / 图鉴 / 收藏箱 五页签（默认进入地图页）
- [x] 商店购买、地点间移动、野外区域与遭遇主题
- [x] 恢复中心全回复、放生、移入队伍、闪光「至尊」标记

### 7) 战斗资源与挂机（2026-11-03 提交：技能 PP + 远征挂机）

- [x] 技能 PP：`getMoveMaxPP` 按威力分档（变化技 15 / 30~5），`MoveSpec.pp` 可覆盖个别技能：[rules.ts](file:///workspace/src/game/rules.ts)
- [x] PP 只存战斗内 `BattleState.ppByMonster`，每场补满、战斗结束丢弃，不写存档、无需迁移：[types.ts](file:///workspace/src/game/types.ts)
- [x] 敌我双方均消耗 PP；PP 归零禁用技能，全耗尽只能干瞪眼
- [x] 首通记录 `SaveData.clearedAreas`，野外区域打赢（击倒或捕获）即写入
- [x] 远征挂机：按已首通区域离线结算金币与捕获器，无战斗模拟，8 小时封顶：[idle.ts](file:///workspace/src/game/idle.ts)、[useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)、[Camp.tsx](file:///workspace/src/pages/Camp.tsx)
- [x] 捕获器掉落按区域难度解锁：Lv10+ 高级捕获器，Lv20+ 特级捕获器，大师球不产出

### 8) 移动端与打包

- [x] 状态栏/刘海沉浸（Capacitor StatusBar）、`android/` 原生目录
- [x] 云端打包 APK 流程与避坑：[apk\_build\_guide.md](file:///workspace/apk_build_guide.md)

### 9) 世界地图与城镇系统（2026-11-03 补记，此前文档遗漏）

- [x] 7 个城镇（初心镇 / 坚石市 / 绿叶镇 / 涌泉市 / 烈阳镇 / 幽影市 / 凛冬镇），各带商店库存、NPC 对话、2 个野生区域与等级带：数据 [data.ts](file:///workspace/src/game/data.ts)（LOCATIONS）、页面 [Camp.tsx](file:///workspace/src/pages/Camp.tsx)
- [x] 旅行与访问记录、全灭后回到最近恢复点：store [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)（travelTo / lastHealLocationId）
- [x] 战斗胜利掉落金钱 + 商店购买道具：store [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)（buyItem）

### 10) 多存档槽与开发用测试菜单（2026-11-03 补记，此前文档遗漏）

- [x] 3 个存档槽 + 槽位切换：store [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)（slot / save1~3）、页面 [Start.tsx](file:///workspace/src/pages/Start.tsx)
- [x] 属性克制交互卡片（替代 18x18 大表格，移动端友好）：组件 [TypeChartModal.tsx](file:///workspace/src/components/TypeChartModal.tsx)
- [x] 测试菜单（一击必杀 / 满个体 / 强制闪光 / 加满金币 / 大师球）：store [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)、页面 [Camp.tsx](file:///workspace/src/pages/Camp.tsx)

---

## 🔄 下一步（按优先级，含验收口径）

> ⚠️ **编号体系说明（2026-11-04）**：本节的 `P0 / P1 / P2` 是**单机内容开发**的阶段编号（图鉴里程碑 / 内容扩充 / 对手与长期目标），与联网改造任务表 `开发任务优先级_2026-11-04.md` 的 `P0~P5`（联网地基 / 服务端权威 / 实时传输 / 服务端模拟 / 多人玩法 / 上线去本地）**是两套完全不同的体系，不要混用**。  
> **联网改造的排期与优先级以任务表为唯一准绳**；本节仅描述内容侧待办。  
> 另：杰哥已拍板最终形态为**服务端权威 + 实时多人同玩**，本地存档为过渡态。**该过渡已于 2026-11-13 完成**——本地存档（persist / 自动上传 / 离线队列 / LWW 冲突策略 / rebase）全部删除，存档只有服务端一份真值。本节涉及存档/数值的待办仍须按「服务端权威」口径评估落点（数值与随机判定必须在服务端）。

### P0：让核心循环产生策略与目标

- [ ] **图鉴里程碑奖励**
  - 入口：`SaveData.milestones`、[useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)、[Camp.tsx](file:///workspace/src/pages/Camp.tsx)
  - 验收：10/20/40/80/120/200 六档；可领取状态与已领取状态清晰；重复进入不重复发奖
- [ ] **捕获反馈动画**
  - 现状：`shakes` 只进日志，无动画
  - 验收：摇晃 1–3 次与成功/失败的可视反馈，可在设置中关闭
- [ ] **捕获率精细化**：当前仅按概率分 3 档摇晃（>0.7 / >0.45 / 其余），未计入稀有度与等级差；血量 / 状态 / 装置因子已有：规则入口 [rules.ts](file:///workspace/src/game/rules.ts)、道具 [data.ts](file:///workspace/src/game/data.ts)

### P1：内容与差异化

- [ ] **幻兽扩充（40 → 200）**：补齐 `dexNum`、栖息地、进化链、learnset：[data.ts](file:///workspace/src/game/data.ts)
- [ ] **Learnset 差异化**：避免同属性幻兽共用一套技能表
- [ ] **技能机（TM）**：`ItemSpec` 增加 `tm`，落地 `teachable` / `exclusiveTo`
- [ ] **战斗信息增强**：速度对比、能力阶图标、命中率可视化

### P2：对手与长期目标

- [ ] **挂机战斗动画（纯表现）**：挂机目前只做时间结算，不播放战斗过程；后续补一段不产生实际结算影响的循环动画
- [ ] **训练师战（最小可用）**：`NpcSpec.team` + 多只连续战斗 + 奖励 + `defeatedTrainers`
- [ ] **携带道具**：`heldItem` + 首批 6 个效果
- [ ] **成就与统计页**：总场次、捕获数、最高连胜、闪光遭遇
- [ ] **区域解锁条件**：地点 `unlockRequirement`

### 🐞 已知遗留缺口（本仓库已落地功能相关的待修项）

- [x] ~~**存档版本迁移脱钩**~~：已随本地存档删除而消失（2026-11-13）。现由 `SCHEMA_VERSION`（前端）与 `EXPECTED_SAVE_VERSION`（后端）两处常量对齐，前端不再有 migrate。
- [ ] **道具进化全链路未完成**：`EvolutionCondition` 已支持 `item`，进化石已在商店售卖，但 `useItemOutsideBattle` 只处理 `kind === "heal"`，进化石买了用不了：入口 [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)、[EvolutionModal.tsx](file:///workspace/src/components/EvolutionModal.tsx)
- [ ] **关键道具无效**：`amulet_coin`（金钱翻倍）、`exp_share`（经验分享）已在商店售卖但无任何效果代码：入口 [useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)

---

## 🧭 中长期

- [ ] 道具进化全链路（`condition.type === "item"`）：背包使用 → `pendingEvolution` → 确认弹窗
- [ ] 分支进化与多条件（等级 + 道具 / 时间 / 亲密度）
- [ ] 挑战塔 / 连胜模式（不回血连续战斗）
- [ ] 存档云同步与多端一致（当前仅本地 + 手动导入导出）
- [ ] Release 签名、版本号与渠道包

---

## 📌 文档与代码一致性核对（2026-11-03 建立，随 2fc7439 同步）

按代码实况核对文档后的偏差清单，供后续同步维护：

| 项       | 文档原描述                   | 代码实况                                                                                      |
| ------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| 营地 Tab  | 早期文档写“队伍 / 背包 / 图鉴”三页签  | 实为五页签：party / bag / **map** / dex / **box**，无独立“进度/训练场”页（2026-11-03 已修正 §6）               |
| 存档      | 早期文档写单存档                | **3 个存档槽**（slot + save1~3），文档 §1 已记                                                       |
| 世界地图    | 早期文档未提及                 | 已落地：7 城镇 + 商店 + NPC + 野生区域（文档 §9）                                                         |
| 属性克制展示  | 18×18 表格（bug_log 第 4 条） | 已改为交互卡片 [TypeChartModal.tsx](file:///workspace/src/components/TypeChartModal.tsx)（文档 §10） |
| 属性数量    | PRD 写 2~3 种（火/水/草/无）    | 实为 **18 种**，含钢/妖精/恶等                                                                      |
| 训练场入口   | 从营地选遭遇主题                | 已改为从地图进入具体野生区域（带等级带）                                                                      |
| PP / 挂机 | 早期文档未记载                 | 本次提交新增：技能 PP 分档、首通记录 `clearedAreas`、远征挂机（文档 §7）                                           |

已处理遗留项：删除 `rules.ts::createInstance` 调试 `console.log`；删除未引用的空壳 `src/pages/Home.tsx`；修正 `tsconfig.json` 非法 `ignoreDeprecations: "6.0"`，构建恢复正常。

---

## ⚠️ 已知环境约束

- ~~当前沙盒**没有 adb / 模拟器 / Android SDK**，`android-performance` 的原生采样（Simpleperf/Perfetto/gfxinfo）与 `android-emulator-qa` 的模拟器流程无法执行~~ → **2026-11-11 订正**：该结论只对 2026-10-20 的沙盒环境成立。本机已重建完整 Android 构建链（SDK 36 / Gradle 8.14.3 / JDK 21），并在雷电 `emulator-5558` 完成 `gfxinfo` / `meminfo` / 冷启动 / 后台恢复四项真机补测（**12/12 全绿**），详见 [性能基线\_web.md](file:///workspace/.trae/documents/性能基线_web.md) §6 / §7 与 `雷电模拟器_adb操作规范_2026-11-11.md`。Web 侧基线仍见前述文档。
- 沙盒容器可能被重建（`node_modules` 消失、内网 IP 变化、预览路由失效），恢复步骤见 [bug\_log.md](file:///workspace/.trae/documents/bug_log.md) 第 8.1 节

---

## 验收口径（贯穿所有阶段）

- 移动端单手可操作，关键入口 ≤ 2 次点击，不依赖横向滚动
- 每次新增持久化字段必须：递增 `SaveData.version` + `migrate` 兜底 + 旧存档可继续玩
- 每次改动后执行 `npm run check` 与 `npm test`
- 新增幻兽必须同时补齐：`dexNum`、`learnset`、捕获率、栖息地主题

---

## 🌐 联网后端（2026-11-03 新增；2026-11-04 更新）

杰哥拍板：App 框架保持 React+Capacitor 不动；联网走**自建 Node+TS 后端**（非 Supabase）。**2026-11-04 追加拍板：最终形态 = 服务端权威 + 实时多人同玩**（WebSocket 实时传输，战斗/捕获/经济由服务端结算，客户端只发意图、收状态）；本地存档为过渡态，**已于 2026-11-13 移除**（现在只有登录态 / 主题等非游戏状态留在本地）。

- **技术栈**：Fastify 4 + @fastify/jwt + @fastify/cors + Prisma 5 + **Postgres 16（P5-1 W1 起）** + bcryptjs + zod + tsx；独立目录 `backend/`，与前端解耦。
- **数据模型**：`User`(用户名唯一 + `role`/`bannedAt`/`banReason`) + `Save`(userId+slot 复合唯一，data 存完整存档 JSON、`schemaVersion`、`clientId`、`updatedAt`；每用户 3 槽) + `BanRecord`(封号审计)。迁移 `20261105101951_add_account_moderation` 已应用。
- **API**：`POST /api/auth/register|login`（返回 JWT，含 `exp`；已封号 403）、`GET /api/auth/me`（返回 `isAdmin`/`banned`）、`GET|PUT /api/save?slot=1|2|3`（PUT 做结构+数值校验 → 风控决策 → 服务端时钟钳制 → upsert）、`GET /api/health`。
- **风控（P1-1 / P1-1b 已完成）**：`saveValidator.ts` 校验数值契约、`antiCheat.ts` 分 `allow/reject/ban`（**改档即封号 + 弹窗登出**，管理员放行测试菜单数据，格式/旧档问题只 400 不封号）、`serverClock.ts` 把未来时间戳钳制为服务端时间（**改系统时间不生效、不封号**）；管理员由 `ADMIN_USERNAMES` 或 `User.role` 服务端判定，用 `npm run admin -- grant <用户名>` 授权。
- **前端现状**（对核心 store 零侵入）：`src/lib/api.ts` / `auth.ts` / `pages/Auth.tsx`（路由守卫强制登录）；**P0-3 那套 localStorage 自动云同步已于 2026-11-13 整体删除**（现由 `saveBootstrap` + `intents` 提交取代），**P0-5 已移除手动备份 UI**；`<BanGate/>` 全局封号弹窗、`useIsAdmin()` 控制测试菜单显隐。
- **启动联调**：`cd backend && npm install && npm run dev`（端口 3001），前端 `npm run dev`（5173）；`npm run admin -- grant <用户名>` 授权管理员；CORS 已放行 5173；register→me→PUT→GET 端到端已验证通过。
- **当前缺口与下一步**：数值校验已能挡「明显改档」，但**关键随机（捕获/经济/挂机）仍在客户端**，GG 修改器在合法区间内微调、加速器改节奏、把系统时间往过去调刷资源、外挂伪造结算都还拦不住；也无 WebSocket 实时层。**下一步首推 P1-2 关键随机与结算上移服务端**（服务端时钟 + RNG + 结算），P3 服务端模拟才彻底根治。详见任务表「六、反作弊与风控需求」。
- 详见项目记忆 `.workbuddy/memory/MEMORY.md` 第 8、9、10 节。

---

## 📋 联网改造任务表（2026-11-04 建立，同日按北极星方向修正）

优先级排序、实施批次与进度记录以该表为**唯一准绳**：[开发任务优先级\_2026-11-04.md](file:///workspace/.trae/documents/开发任务优先级_2026-11-04.md)。  
该表已按「服务端权威 + 实时多人同玩」重排为 P0~P5 六阶段；上文及本路线图的任何「待办」表述如与该表冲突，以该表为准；每完成一项回填该表的「进度记录」。
