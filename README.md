# 幻兽收集回合制 RPG（Web + Capacitor/Android）

一个以“回合制战斗 + 捕获 + 队伍管理 + 图鉴收集”为核心循环的原创 RPG 原型项目，前端为 React + TypeScript + Vite，并支持通过 Capacitor 在云端环境打包 Android APK。

## 快速开始

### 1) 安装依赖

```bash
npm install
```

### 2) 启动开发服务器

```bash
npm run dev -- --host 0.0.0.0 --port 5173 --strictPort
```

### 3) 构建与检查

```bash
npm run build
npm run check
npm test
```

## 目录结构（关键入口）

- 游戏数据与规则：[/src/game](file:///workspace/src/game)
  - 数据库（技能/幻兽/道具/主题）：[data.ts](file:///workspace/src/game/data.ts)
  - 回合制规则与成长/进化：[rules.ts](file:///workspace/src/game/rules.ts)
  - 核心类型定义：[types.ts](file:///workspace/src/game/types.ts)
- 全局存档与流程：[/src/stores](file:///workspace/src/stores)
  - Zustand store：[useGameStore.ts](file:///workspace/src/stores/useGameStore.ts)
- 页面：
  - 营地/图鉴/商店：[Camp.tsx](file:///workspace/src/pages/Camp.tsx)
  - 战斗/捕获：[Arena.tsx](file:///workspace/src/pages/Arena.tsx)
- 弹窗组件：
  - 机制表：[MechanicsModal.tsx](file:///workspace/src/components/MechanicsModal.tsx)
  - 技能图鉴：[MoveChartModal.tsx](file:///workspace/src/components/MoveChartModal.tsx)
  - 学技能：[MoveLearnerModal.tsx](file:///workspace/src/components/MoveLearnerModal.tsx)
  - 进化：[EvolutionModal.tsx](file:///workspace/src/components/EvolutionModal.tsx)

## 文档索引

- 路线图与任务拆解：[/workspace/.trae/documents/开发路线图_roadmap.md](file:///workspace/.trae/documents/开发路线图_roadmap.md)
- 云端打包 APK 指南：[apk_build_guide.md](file:///workspace/apk_build_guide.md)
- 常见问题排查：[/workspace/.trae/documents/bug_log.md](file:///workspace/.trae/documents/bug_log.md)
- PRD：[/workspace/.trae/documents/PRD-原创抓怪回合制RPG.md](file:///workspace/.trae/documents/PRD-原创抓怪回合制RPG.md)
- 技术架构：[/workspace/.trae/documents/技术架构-原创抓怪回合制RPG.md](file:///workspace/.trae/documents/技术架构-原创抓怪回合制RPG.md)

## Android（Capacitor）

已包含 Capacitor 相关依赖与 `android/` 原生目录；云端构建步骤与避坑见 [apk_build_guide.md](file:///workspace/apk_build_guide.md)。
