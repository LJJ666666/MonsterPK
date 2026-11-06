# 后端开发规范（MonsterPK Backend）

> 用途：补齐后端开发约定。此前项目文档只规定了前端规范（模块化、中文注释等），
> 后端自成一套独立目录 `backend/`，本文档沉淀其目录结构、模块职责、API 约定、
> 编码规范、迁移流程与安全要点，供后续联网功能（实时传输、服务端模拟等）沿用。
> 前端规范见《技术架构》《开发路线图》等相关文档，二者共享「中文注释 + 移动端优先」基调。
>
> **2026-11-05 更新**：新增 P1-1b 账号风控（管理员 / 封号 / 服务端时钟），
> 并明确 P1-2、P3 的反作弊验收边界，见 §13。

---

## 1. 定位与技术栈

后端是**最小可用的联网层**，当前负责：账号、登录态、存档落盘与校验、账号风控。
北极星方向是「服务端权威 + 实时多人同玩」，后续实时传输与服务端模拟都在其基础上扩展。
设计原则与前端一致——**能本地联调、未来搬到云只改连接地址**。

| 项 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js (ESM) + `tsx` 热重载 | `backend/` 独立 `package.json`，与前端的依赖完全解耦 |
| Web 框架 | Fastify 4 | 轻量、内置校验钩子、装饰器机制灵活 |
| 鉴权 | `@fastify/jwt` + `@fastify/cors` | JWT 签发含 `exp`；CORS 仅放行前端来源 |
| ORM | Prisma 5 | 数据模型即文档，`migrate dev` 生成可复现迁移 |
| 数据库 | SQLite（`dev.db` 文件库） | 开发期；上线切 Postgres 只需改 `provider` 与 `DATABASE_URL` |
| 密码 | `bcryptjs` | 明文密码只进哈希，绝不落库 |
| 入参校验 | `zod` | 每个路由先用 `safeParse` 拦非法入参 |
| 配置 | `.env` + `lib/env` | 密钥/端口/跨域来源/管理员白名单外置，`.env` 入 `.gitignore` |

> 端口约定：后端 `:3001`，前端 `:5173`。前端通过 `VITE_API_BASE` 覆盖后端地址（默认 `http://localhost:3001`）。

---

## 2. 目录结构与模块化

```
backend/
├── prisma/
│   ├── schema.prisma          # 数据模型（唯一真源）+ 迁移基线
│   ├── migrations/            # 每次 schema 变更的 SQL 迁移（可复现、可提交）
│   └── dev.db                 # 开发期文件库（不提交）
├── scripts/
│   └── admin.ts               # 账号管理 CLI：grant / revoke / ban / unban / list / audit
├── src/
│   ├── index.ts               # 启动入口：装配 Fastify、认证守卫（含封号检查）、注册路由
│   ├── lib/
│   │   ├── env.ts             # 最先执行：加载 .env 后再初始化其他模块
│   │   ├── prisma.ts          # PrismaClient 单例
│   │   ├── password.ts        # bcrypt 哈希 / 校验封装
│   │   ├── saveValidator.ts   # 存档结构与数值契约校验（P1-1，纯函数，只产出问题不决定处置）
│   │   ├── antiCheat.ts       # 风控决策（P1-1b，纯函数）→ allow / reject / ban
│   │   ├── serverClock.ts     # 客户端未来时间戳钳制为服务端时间（P1-1b，纯函数）
│   │   └── account.ts         # 管理员判定 / 封号状态查询 / 封号执行（含审计）
│   └── modules/
│       ├── auth.ts            # /api/auth/*：注册 / 登录（拒封号）/ 取当前用户（含 isAdmin）
│       └── save.ts            # /api/save：读 / 写存档（校验→风控→钳制→落库）
├── tests/
│   ├── saveValidator.test.ts     # node:test 单测（数值契约）
│   ├── antiCheat.test.ts         # node:test 单测（风控决策）
│   ├── serverClock.test.ts       # node:test 单测（时间钳制）
│   └── e2e_save_validation.mjs   # 端到端可复现脚本（需服务已启动）
├── package.json
└── tsconfig.json
```

**模块化约定（与前端一致）：**
- 每个业务域一个 `modules/*.ts`，文件名即职责，内部只导出 `xxxRoutes(fastify)` 装配函数。
- `index.ts` 只做「装配」，不写业务细节；业务细节下沉到 `modules/`。
- 公共能力（数据库、密码、环境变量、风控）收敛到 `lib/`，禁止在路由里直接 `new PrismaClient()` 或硬编码密钥。
- **纯函数优先**：校验 / 决策 / 时间处理均为零依赖纯函数（可注入 `now`），便于单测与复用。
- 所有跨文件共享的常量（如 JWT 过期时间、存档大小上限）尽量就近定义并加中文注释。

---

## 3. 数据模型（Prisma）

```prisma
model User {
  id        String   @id @default(cuid())
  username  String   @unique
  password  String                 // bcrypt 哈希，绝不明文
  role      String   @default("player")  // player / admin（管理员可用测试菜单，改档特征放行）
  bannedAt  DateTime?              // 非空即已封号，认证守卫拒绝所有后续请求
  banReason String?                // 封号中文原因（前端弹窗展示）
  createdAt DateTime @default(now())
  saves     Save[]
  bans      BanRecord[]
}

model BanRecord {
  id        String   @id @default(cuid())
  userId    String                 // 关联 User，级联删除
  slot      Int?                  // 触发封号的存档槽位
  codes     String                 // 违规码列表（JSON 文本）
  reason    String                 // 中文原因
  stats     String?                // 存档摘要（JSON 文本，不存完整存档，避免表膨胀）
  createdAt DateTime @default(now())
  @@index([userId, createdAt])
}

model Save {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  slot          Int
  data          String                 // 完整存档 JSON 文本（前端 exportSaveJson 的产物）
  schemaVersion String   @default("unknown")  // 取自 data 解析后的 version 字段
  clientId      String?                // 最近写入的客户端标识（每设备唯一）
  updatedAt     DateTime @updatedAt
  @@unique([userId, slot])             // 每用户 3 槽位复合唯一
}
```

> ~~**旧约定（P0-2，已废弃）**：`data` 对服务端是「不透明 JSON 字符串」，只做最小结构校验。~~
>
> **现行约定（P1-1 起）**：服务端**会解析 `data` 的数值契约**（见 §5）。
> 但为控制耦合，当前只校验**与游戏内容表无关的数值不变量**（范围 / 类型 / 结构 / 版本），
> **不硬编码** 40 只幻兽、22 个道具、300+ 技能的白名单；ID 真值校验与进化链校验留到 P3
> （服务端持有内容表、成为唯一真相来源时）再做，避免双端数据漂移。
> `schemaVersion` / `clientId` / `updatedAt` 是冲突判断与防脏档的元数据，不属于游戏数据。

---

## 4. API 设计约定

### 4.1 路由清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 否 | 注册，返回 JWT（含 `iat`+`exp`） |
| POST | `/api/auth/login` | 否 | 登录，返回 JWT；**已封号返回 403** |
| GET | `/api/auth/me` | 是 | 返回 `id`/`username`/`isAdmin`/`banned` |
| GET | `/api/save?slot=1\|2\|3` | 是 | 读存档，返回 `data` + `updatedAt`/`clientId`/`schemaVersion` |
| PUT | `/api/save?slot=1\|2\|3` | 是 | 写存档（校验→风控→钳制→落库），返回最新元数据 |
| GET | `/api/health` | 否 | 探活 |

### 4.2 鉴权与错误码

- 所有受保护路由挂 `preHandler: fastify.authenticate`；该装饰器在 `index.ts` 用 `fastify.decorate` 注入，
  并用 `declare module 'fastify'` 做**类型声明**（否则 `tsc` 报 `authenticate` 不存在）。
- 守卫除 `jwtVerify()` 外，还会**实时查库判断封号状态**，并把账号视图写入 `req.account` 供路由复用。
  封号必须即时生效，不能等 30 天的 JWT 自然过期。
- JWT 过期 / 缺失 → `401`；前端 `api.ts` 清 token 并广播 `mpk:unauthorized` → `<UnauthorizedListener/>` 跳登录页。
- **账号已封 → `403`**，响应 `{ error: "你已被封号", code: "ACCOUNT_BANNED", reason }`；
  前端 `api.ts` 广播 `mpk:banned` → `<BanGate/>` 弹窗，用户确认后清 token 跳登录页。
- 错误响应统一 `{ error: "中文说明" }`，便于前端直接展示。
- 状态码口径：`200` 成功 / `400` 入参或存档结构非法 / `401` 未登录或过期 /
  `403` 账号被封 / `404` 该槽位无存档 / `409` 用户名重复。

### 4.3 入参与出参

- 入参一律先 `z.object({...}).safeParse(req.body)`，失败即 `400`，**不手动拼错**。
- `PUT /api/save` 入参：`{ data: string(≤5MB), clientId?: string(≤64) }`。
- `GET /api/save` 出参：`{ slot, data, updatedAt, clientId, schemaVersion }`。
- `slot` 用 `z.coerce.number().int().min(1).max(3)` 收敛，杜绝越界槽位。

---

## 5. 存档校验、风控决策与服务端时钟（P1-1 / P1-1b）

职责分三层，**校验器不决定处置**：

| 层 | 文件 | 职责 |
|---|---|---|
| 校验 | `lib/saveValidator.ts` | 纯函数，产出 `{ ok, schemaVersion, hard, soft, stats }`；只描述「有什么问题」 |
| 决策 | `lib/antiCheat.ts` | 纯函数 `decideSaveAction(validation, isAdmin)` → `allow` / `reject` / `ban` |
| 时钟 | `lib/serverClock.ts` | 纯函数 `clampSaveTimestamps(raw, now)` → 把未来时间戳改写为服务端时间 |

### 5.1 三级处置（关键设计）

| 处置 | 触发条件 | 服务端动作 | 前端表现 |
|---|---|---|---|
| `reject` | 结构 / 格式 / 版本错配（非改档特征） | `400`，不封号 | 同步相位 error，展示中文原因 |
| `ban` | 普通账号出现**改档特征**（见下） | 写 `BanRecord` + 置 `bannedAt`，`403 ACCOUNT_BANNED` | 「你已被封号」弹窗 + 强制登出 |
| `allow` | 无违规 / 仅旧档兼容告警 / **管理员**带改档特征 | 时间钳制后 upsert | 正常同步 |

**防误封原则**：`antiCheat.ts` 采用**改档特征白名单** `CHEAT_CODES`。未列入的违规一律只 `400`、
不封号——旧版存档、内容表更新、客户端 bug、网络损坏都可能造成格式异常，拿这些封号会误伤正常玩家。
`CHEAT_CODES` 含数值越界类 hard（`MONEY`/`MONSTER_LEVEL`/`hp>maxHp`/队伍超容量…）
与测试菜单级 soft（`MONEY_HIGH`/`MONSTER_LEVEL_HIGH`/`MONSTER_EXP_OVERFLOW`/`COLLECTION_TIMES_HIGH`）。

**管理员例外**：由 `lib/account.ts` 服务端判定（`User.role === 'admin'` 或 `.env` 的
`ADMIN_USERNAMES` 白名单，取并集），改档特征放行并写 `admin_override` 日志；
但**结构损坏的存档仍拒绝**（管理员也不能往库里写非 JSON）。管理员身份绝不接受客户端上报。

### 5.2 系统时间攻防（不封号，只不生效）

杰哥拍板：「不允许修改系统时间获取资源……应该不涉及封号？只是不生效就行吧」。据此：

- `saveValidator.ts` **不再**因「时间戳晚于服务器」产生 `TIMESTAMP_FUTURE` 违规；只检查时间格式是否可解析。
- `serverClock.ts` 把 `lastSavedAt` / `idle.startedAt` 中晚于 `now + 5min` 的值改写为服务器时间，
  再落库。效果：改时间拿不到额外收益，也无法凭未来时间永远赢 P0-3 的 last-write-wins 冲突决策。
- 全程 `200` 放行、不封号、不写告警，只写一条 `save_clock_clamped` info 日志留痕。
- ⚠️ **边界**：把时间往「过去」调以刷挂机收益，客户端写 `startedAt` 时服务端无从判断，
  必须等 **P1-2 把挂机结算上移服务端**（服务端自己记录 `startedAt`、按服务端时钟算 delta）才能根治。

### 5.3 校验范围与版本耦合

- **结构层（P0-2 回归）**：合法 JSON、顶层对象、含 `version: string` + `party: array` + `inventory: object`。
- **版本一致性**：`version` 必须是纯数字字符串且**不高于** `EXPECTED_SAVE_VERSION`（当前 10）。
  高于服务端版本多为部署错配或伪造 → `reject`（不封号）；低于则放行并告警。
  ⚠️ 前端改 `SCHEMA_VERSION` 时**必须同步**改本常量，否则新档全被拒。
- **数值不变量**：金钱 / 步数 / 等级 / 经验 / HP / 六维 / 道具堆叠 / 捕获次数必须是有限非负整数且不超上限；
  `hp <= maxHp`；`moveIds <= 4`；`party <= 6`；属性与异常状态须在固定枚举内。
- **结构化日志**：`save_rejected`（400，含 codes）、`save_banned`（403，含 codes/stats）、
  `admin_override`、`save_clock_clamped`、`save_suspicious`，均带 `userId`/`slot`，便于审计。

### 5.4 能力边界（务必如实告知，不要夸大）

能识别「明显改档」：负数、NaN、超上限、类型伪造、超队伍容量、`hp>maxHp`、版本与数值异常、
测试菜单级的满属性 / 满金币。
**挡不住「合法范围内的微调」**（例如把 `money` 从 100 改成 500），也看不见
**GG 修改器改内存、加速器改客户端节奏、外挂直接构造请求**。
彻底防作弊依赖 **P1-2 关键随机/结算上移服务端** 与 **P3 服务端模拟**（客户端不持有游戏真值），
见 §13 与任务表 P1-2 / P3-1 验收口径。

---

## 6. 编码规范

- **中文注释**：模块头、关键分支、非显然逻辑都要写中文注释（与前端一致）。
- **单一职责**：路由函数只做「解析 → 校验 → 委托 → 组装响应」；算法下沉到 `lib/`。
- **不信任前端（服务端权威原则）**：任何入参先 zod 校验；密码只存哈希；`data` 限 5MB；
  客户端上报的存档 / 战报 / 数值一律先经校验与风控决策，不得直接落库；关键 RNG 与结算逐步上移服务端。
- **身份只在服务端判定**：管理员、封号状态一律查库 / 读服务端配置，绝不读请求体或 JWT 里的 role 声明。
- **封号要留痕可解封**：每次封号事务里同时写 `BanRecord` 与 `User.bannedAt`；
  解封走 `npm run admin -- unban <用户名>`，不得直接删审计记录。
- **阈值集中**：校验上限在 `SAVE_LIMITS`、改档特征在 `CHEAT_CODES`，改一处即可，不要散落魔法数字。
- **装饰器要声明类型**：`fastify.decorate('authenticate', ...)` 后必须配 `declare module 'fastify'` 接口声明。
- **错误用中文、不抛裸异常**：业务错误返回结构化 `{ error }`；未预期异常交给 Fastify 默认错误处理。
- **配置外置**：端口、JWT 密钥、JWT 过期、CORS 来源、管理员白名单全走 `.env`，不写死在代码。

---

## 7. 数据库迁移流程

1. 改 `prisma/schema.prisma`。
2. **先停掉正在运行的 backend dev 服务**（见 §8 坑位），否则 `prisma generate` 会因 Windows 文件锁 EPERM 失败。
3. `npx prisma migrate dev --name <语义化名字>` —— 生成 SQL 迁移并应用到 `dev.db`，随后自动 `generate`。
4. 若 `generate` 报 EPERM（rename query_engine DLL），重启 dev 服务前确认无 backend 进程占用 :3001。
5. 迁移文件**必须提交**；上线切 Postgres 时按 Prisma 官方流程重跑迁移即可。
6. 重置开发库：`npx prisma migrate reset`（会清数据，仅本地用）。
7. 家里 / 新机器重建：`cp .env.example .env` → 填 `JWT_SECRET` 与 `ADMIN_USERNAMES` →
   `npx prisma migrate deploy` → `npx prisma generate`。

---

## 8. 已知环境坑（务必先看 bug_log）

- **§11 vitest EPERM**：沙盒 brokered-fs 垫片拦截并发写系统 Temp，测试脚本须加 `--no-file-parallelism`。
- **§12 prisma generate EPERM**：backend 进程占用查询引擎 DLL，Windows 禁止改名；改 schema 前先停 backend。
- **§13 两套测试框架混跑**：前端 vitest 会扫到后端 `node:test` 文件报 `No test suite found`；
  已在 `vite.config.ts` 用 `test.include/exclude` 划清边界。
- **§14 `.env` 路径算错（安全缺陷，已修）**：`lib/env.ts` 原写 `resolve(here, '../.env')` 指向
  `backend/src/.env`（不存在），导致 `JWT_SECRET` 一直用代码里的默认密钥、`.env` 形同虚设。
  正确为 `resolve(here, '../../.env')`。**改配置后必须实测 `process.env.JWT_SECRET` 有值**。
- **§10 useNavigate 白屏**：前端坑，但提醒——401 跳转逻辑必须放在 `<Router>` 内子组件。

---

## 9. 本地运行与测试

```bash
cd backend
npm install
cp .env.example .env          # 填 JWT_SECRET / PORT / CORS_ORIGIN / ADMIN_USERNAMES
npx prisma migrate dev        # 建库 + 生成 Client
npm run dev                   # tsx watch，默认 :3001
npm run admin -- grant <用户名>   # 给自己的账号授权管理员（否则测试菜单不可见）
```

**测试口径（每次后端改动后）：**
- `npm run check`（`tsc --noEmit`）类型检查必须通过。
- `npm test`（`tsx --test tests/*.test.ts`，Node 内置 `node:test`）纯函数单测必须通过。
  **后端用 `node:test`，前端用 `vitest`，两套框架独立**，新增测试放 `backend/tests/`。
- `npm run e2e`（`node tests/e2e_save_validation.mjs`，**需后端已在 :3001 运行**）端到端覆盖：
  结构/格式 400 不封号 → 合法档 200 → 未来时间戳 200 且被钳制 →
  改档 403 封号（后续请求 403 / 重登 403 / `bannedAt` + 审计落地）→
  管理员放行改档但拒绝坏结构 → 解封恢复 → 被拒档不落库。脚本固化为可复现证据，不写临时探针。
- 与前端联调：确认 `:5173` 与 `:3001` 双活、CORS 头正确、带 Origin 的链路全绿。

**实测基线（2026-11-05）**：后端 `node:test` **53/53**、`npm run e2e` **57/57 `E2E_OK`**；
前端 vitest **27/27**、`npm run check` 0、`npm run build` 通过；
headless Edge **20/20 `PROBE_OK`**（普通账号无测试菜单 / 管理员可见 / 封号弹窗 + 登出 / 375px 不溢出）。

---

## 10. 安全要点（最小集合）

- 密码 bcrypt 哈希；JWT 含 `exp`（默认 30d，可配 `JWT_TTL`）。
- **`JWT_SECRET` 必须来自 `.env`**；曾因 `lib/env.ts` 路径错误长期回落到硬编码默认值（见 §8/§14）。
- 所有写操作经 JWT 守卫；守卫额外查封号状态，封号即时生效且不因换设备/清缓存被绕过。
- **管理员授权只在服务端**：`ADMIN_USERNAMES`（`.env`）或 `User.role`，客户端伪造无效。
- 存档 `data` 限 5MB；`slot` 强制 1~3；结构损坏的存档绝不入库。
- 封号审计与账号状态在同一事务写入，误封可用 `npm run admin -- unban` 恢复并留痕。
- CORS 仅放行前端来源，不开放 `*`。
- 上线前：密钥走环境变量、启用 HTTPS、数据库改为托管 Postgres、`JWT_TTL` 缩短。

---

## 11. 与前端联调约定

- 前端 `src/lib/api.ts` 的 `API_BASE` 默认 `http://localhost:3001`，生产用 `VITE_API_BASE` 覆盖。
- 前端 `src/lib/auth.ts` 只做 token 的本地解码/有效性判断（不校验签名，签名由后端 JWT 守卫负责）。
- 存档同步为**自动**（P0-3：`src/lib/sync.ts` 防抖上传 + 离线队列 + 登录按冲突策略恢复），手动备份 UI 已于 P0-5 移除。**该方案是过渡桥接**，P3 客户端变瘦终端后退役。
- **P1-1 联动**：`src/lib/syncErrors.ts` 把 4xx（除 429）判为 permanent，`sync.ts` 三处上传路径
  不再把被拒档放进离线队列；`Start.tsx` error 相位展示后端中文原因，窄屏自动换行。
- **P1-1b 联动**：
  - `api.ts` 遇 `403 + code=ACCOUNT_BANNED` 广播 `mpk:banned`（与 401 的 `mpk:unauthorized` 分开）。
  - `App.tsx` 的 `<BanGate/>` 在 `<Routes>` 之外全局监听，弹「你已被封号」+ 后端原因，
    确认后 `clearToken()` + 跳 `/auth`；小 `max-w` + `overflow-auto` + 长文案换行适配 375px。
  - `src/lib/admin.ts` 的 `useIsAdmin()` 从 `/api/auth/me` 取 `isAdmin`；
    `Camp.tsx` 测试菜单、`Start.tsx` 管理员标识仅管理员可见。**这只是 UI 收敛，不是安全边界**。
  - 403 属 permanent，不入离线队列，不会重复触发弹窗风暴。

---

## 12. 演进待办（对照 `.trae/documents/开发任务优先级_2026-11-04.md`）

> 编号以任务表为准；本节只列后端相关项。P0 五项、P1-1、P1-1b 均已完成。

- ✅ **P0-3 自动云同步**：登录按冲突策略自动恢复、防抖自动 PUT、离线队列重传、同步状态 UI（过渡桥接）。
- ✅ **P1-1 服务端存档数值校验**：`saveValidator.ts` 分级校验 + 告警日志 + 前端 4xx 分流。
- ✅ **P1-1b 管理员权限 + 封号风控 + 服务端时钟**：见 §5、§13。
- ⬜ **P1-2 关键随机与结算上移服务端**：捕获判定、金币/道具/挂机结算由服务端裁决；
  **挂机 `startedAt` 必须服务端记录**（根治「把系统时间往过去调」刷资源）；捕获结果客户端不可伪造。
- ⬜ **P2-1/P2-2 WebSocket 实时传输层 + GameSession 在线权威态**：替代静态 `Save` blob。
- ⬜ **P3 服务端模拟**：战斗/捕获/挂机逻辑上移服务端，客户端变瘦终端（此时才真正防住 GG 修改器 / 加速器）。
- ⬜ **P5 上线与去本地**：SQLite → Postgres、HTTPS、`VITE_API_BASE`/`CORS_ORIGIN` 切云、
  去除本地存档持久化（须等服务端权威 + 实时就绪后才安全）。

---

## 13. 反作弊与风控需求（杰哥 2026-11-05 拍板）

### 13.1 需求原文要点

- 满属性 / 高等级 / 满金币这类测试菜单数据**不能一律放行**，改为**管理员权限**：
  只有杰哥自己的账号可以带这类数据，用于测试游戏。
- 他人通过外挂、GG 修改器、加速器、以及自带 test 功能改数据，**一律拦下**，
  并弹出「你已被封号」，然后退出登录。
- 改系统时间获取资源：不允许，但**不封号**，只要「不生效」即可。
- 最终方向：服务端权威 + 实时多人同玩（P1-2 随机上移 + P3 服务端结算）。

### 13.2 攻防分工边界（务必按层次理解，不要夸大 P1-1b）

| 攻击手段 | P1-1b（当前已落地） | 根治层 | 根治机制 |
|---|---|---|---|
| 直接改存档 JSON 的数值到越界 / 测试菜单级极值 | ✅ 拦截 + 封号 | P1-1b | 改档特征白名单 → `ban` |
| 填未来时间戳让本地永远覆盖云端 / 刷挂机 | ✅ 钳制为服务端时间，不生效、不封号 | P1-1b（未来）/ P1-2（过去） | 服务端时钟 + 服务端记录 `startedAt` |
| 合法区间内微调数值（money 100→500） | ❌ 看不见 | **P1-2 / P3** | 服务端结算经济，客户端无真值 |
| GG 修改器改客户端内存 | ❌ 看不见 | **P3** | 客户端只收状态、发意图，内存里没有可改的游戏真值 |
| 加速器 / 变速改客户端节奏 | ❌ 看不见 | **P2 / P3** | 回合计时、冷却、心跳由服务端裁决 |
| 外挂直接构造 HTTP 请求伪造结算 | ❌ 只能挡明显越界 | **P1-2 / P3** | 关键 RNG 与结算上移，请求只带意图、带 nonce 防重放 |
| 被封后换账号重注册 | ❌ 无法根治（无实名/设备指纹） | 运营侧 | 设备指纹 / 实名 / 人工审核，不在当前开发范围 |

### 13.3 P1-2 / P3-1 追加验收口径（已同步进任务表）

- **P1-2**：① 捕获成功与否、金币/道具/挂机结算全部由服务端裁决，客户端不再决定成败；
  ② 所有 `startedAt` / 冷却 / 收益 delta 以**服务端时钟**为准，改系统时间（往前或往后）均不产生额外资源，**且不封号**；
  ③ 关键 RNG 在服务端，结果不可被客户端伪造；④ 意图请求带 nonce / 幂等键防重放；
  ⑤ 端到端可复现（含「改时间不生效」用例）。
- **P3-1**：① 客户端只发意图（`用 X 技能` / `丢球`），服务端结算并广播；
  ② `rules.ts`/`idle.ts`/`gen.ts` 核心逻辑服务端化，客户端不持有可改写的游戏真值；
  ③ **GG 修改器改内存无效**、**加速器改节奏无效**（回合计时由服务端）；
  ④ 配合 P3-2 瘦终端后，P5-2 才安全去除本地存档持久化。

### 13.4 误封防线与运维

- `CHEAT_CODES` 是白名单：格式 / 旧档 / 版本错配一律只 `400`，绝不封号。
- 每次封号写 `BanRecord`（codes、原因、摘要、时间），可用 `npm run admin -- audit <用户名>` 查。
- 解封：`npm run admin -- unban <用户名>`；授权 / 撤销：`grant` / `revoke`。
- 管理员白名单在 `.env`，**绝不写死固定用户名**（否则公网谁注册这个名字谁就是管理员）。
- ⚠️ 前端升 `SCHEMA_VERSION` 时后端 `EXPECTED_SAVE_VERSION` 必须同步，否则全体新档被拒。

## 14. P1-2 意图裁决与权威摘要（2026-11-06 新增）

### 14.1 模块划分

| 文件 | 职责 | 约束 |
|---|---|---|
| `lib/authority.ts` | 资源摘要提取、单调比对、新档 rebase 校验、authority 解析/序列化 | 纯函数，不连库 |
| `lib/settlements.ts` | 服务端 RNG、服务端时钟挂机结算、捕获率公式、奖励/价格计算、精确增量核对 | 纯函数，RNG 与 now 由参数注入便于单测 |
| `modules/actions.ts` | `POST /api/actions/:type`：nonce 消费 → 基线落库 → 裁决 → 登记 pending | 唯一写 authority.pending 的入口 |
| `modules/save.ts` | `PUT /api/save` 三分支：rebase / intentNonce / 普通单调比对 | 唯一写 DB 存档的入口 |
| `Save.authority`（JSON 文本） | expected 资源摘要 + 挂机会话服务端时钟 + revision + pending | 与存档同一行、同一事务，避免漂移 |
| `IntentLog` | `(userId, slot, nonce)` 唯一索引防重放 | 裁决失败也消费，禁止重试刷 RNG |

### 14.2 硬约束

1. **任何资源增加必须走意图接口**。新增玩法若会改 money / inventory / party 数量 / 捕获数 / 首通区域，先在 `settlements.ts::decideIntent` 增加裁决分支并写 `allow.exact` 或 `allow.max`，否则整包 PUT 会被 `AUTHORITY_MISMATCH` 拒绝。
2. **服务端内容常量单一真源**：`ITEM_PRICES` / `CAPTURE_MODIFIER` / 挂机参数在 `settlements.ts`，改前端 `data.ts` / `idle.ts` 的价格与掉落参数时**必须同步**，否则商店显示与裁决结果会漂移。
3. **时钟只认服务端**：挂机 `startedAt` 来自 `authority.idleStartedAtMs`，客户端 `idle.startedAt` 仅作展示；`clampSaveTimestamps` 继续钳制未来时间戳（改系统时间不生效、不封号）。
4. **nonce 一次性**：前端用 `rules.ts::uuid()` 生成（禁用 `crypto.randomUUID`）；服务端 `IntentLog` 唯一索引，`P2002` → 409 `INTENT_REPLAY`。**裁决失败也必须消费**。
5. **提交必须立即**：前端 `commitIntent()` 会 `cancelPendingUpload()` 并跳过 1.5s 防抖；新写的意图路径不要退回普通 `scheduleUpload`，否则旧快照会把服务端裁决覆盖回去。
6. **封号口径不变**：权威摘要不符 / 增量不符一律 **400 + 中文原因 + path，不封号**（防网络竞态误伤）；只有 `antiCheat.ts` 识别的明显改档才 403 封号。
7. **管理员例外只有两处**：`admin_test` 意图（服务端判 `isAdmin`）与 `decideSaveAction` 的 `adminOverride`；前端 `useIsAdmin()` 永远只是 UI 收敛。
8. **新增持久化字段**：本轮未改存档结构，故 `SCHEMA_VERSION` 仍为 10、后端 `EXPECTED_SAVE_VERSION` 仍为 10；若后续给 SaveData 加字段，按第 3 节硬约束递增两处并补 migrate。

### 14.3 能力边界（如实说明）

已挡：改存档加钱/加道具/加等级、绕过 UI 直接 PUT、伪造捕获成功、白嫖购买、重复领奖、改系统时间刷挂机、伪造 rebase 洗白、普通账号调测试菜单。
未挡（留 P3）：GG 修改器改客户端内存、加速器改节奏、战斗中间态 HP/PP/状态伪造、`captureRate` 等 ID 真值伪造（当前只做 0.62 上界钳制）。
