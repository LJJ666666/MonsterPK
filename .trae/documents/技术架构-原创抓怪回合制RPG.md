## 1. 架构设计

```mermaid
flowchart TB
  UI["前端UI（React）"] --> STATE["状态管理（轻量Store）"]
  UI --> ROUTER["路由（SPA）"]
  STATE --> RULES["规则引擎（战斗/捕获/掉落）"]
  RULES --> DATA["数据层（静态JSON：怪物/技能/道具）"]
  STATE --> SAVE["存档（localStorage + JSON导入导出）"]
  UI --> ASSETS["资源（原创SVG/像素风CSS）"]
```

## 2. 技术说明
- 前端：React@18 + TypeScript + Vite
- 样式：tailwindcss@3（配合CSS变量实现主题与像素边框组件）
- 路由：react-router-dom（仅前端路由）
- 数据：本地静态数据（JSON/TS常量），无后端、无外部服务
- 存档：localStorage（自动保存）+ 文件导入导出（JSON）

## 3. 路由定义
| 路由 | 用途 |
|---|---|
| / | 启动页（新游戏/继续/导入导出/设置） |
| /camp | 营地（队伍/背包/图鉴/训练场入口/进度） |
| /arena | 训练场（对战+捕获） |

## 4. API 定义
无后端API。

## 5. 服务端架构图
无（纯前端静态站点）。

## 6. 数据模型
### 6.1 数据模型定义

```mermaid
erDiagram
  SAVE ||--o{ PARTY_SLOT : "contains"
  SAVE ||--o{ COLLECTION_ENTRY : "contains"
  SAVE ||--o{ INVENTORY_ITEM : "contains"
  MONSTER_SPEC ||--o{ MONSTER_INSTANCE : "instantiates"
  MOVE_SPEC ||--o{ MONSTER_INSTANCE : "has moves"

  SAVE {
    string version
    string playerName
    int money
    int steps
    string lastSavedAt
  }

  PARTY_SLOT {
    int index
    string monsterId
  }

  COLLECTION_ENTRY {
    string monsterSpecId
    boolean seen
    boolean captured
    int timesCaptured
  }

  INVENTORY_ITEM {
    string itemId
    int quantity
  }

  MONSTER_SPEC {
    string id
    string name
    string element
    int baseHp
    int baseAtk
    int baseDef
    int baseSpd
    int captureRate
  }

  MOVE_SPEC {
    string id
    string name
    string element
    int power
    int accuracy
    string effect
  }

  MONSTER_INSTANCE {
    string id
    string specId
    int level
    int hp
    int maxHp
    int atk
    int def
    int spd
    string status
    string[] moveIds
    int exp
  }
```

### 6.2 数据定义语言
不使用数据库，数据以TS/JSON静态文件维护；存档以JSON结构持久化。
