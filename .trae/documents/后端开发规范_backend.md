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
- ✅ **P1-2 关键随机与结算上移服务端**：见 §14；捕获判定、金币/道具/挂机结算均由服务端裁决，挂机 `startedAt` 用服务端时钟。
- ✅ **P2-1 WebSocket 实时通道 + P2-2 GameSession 在线权威态**：见 §15 / §16；状态写入收敛到 `commitState()`，客户端只收 `session.state` 快照。
- ⬜ **P3 服务端模拟（下一步 P3-1）**：战斗/捕获/挂机中间态上移服务端，客户端变瘦终端（此时才真正防住 GG 修改器 / 加速器）。
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

---

## 15. P2-1 实时通道（WebSocket 接入与鉴权）

### 15.1 选型与目录

| 项 | 约定 |
|---|---|
| 依赖 | `ws@8`（运行时）+ `@types/ws`（开发）。不引入 `@fastify/websocket` 插件 |
| 路径 | `GET /ws`，与 `/api/*` 分开，便于网关按路径分流 |
| 装配 | `modules/realtime.ts::registerRealtime(fastify)` 在 `index.ts` 里于 `listen` 之前调用 |
| 纯函数 | `lib/wsProtocol.ts`（协议 / 握手校验 / 拒绝响应）、`lib/wsRegistry.ts`（按用户会话登记） |
| 前端 | `src/lib/ws.ts`（唯一客户端）、`App.tsx` 的 `<RealtimeBootstrap/>`、`Start.tsx` 状态行 |

**为什么直接用 `ws` 不用插件**：浏览器原生 WebSocket 不能自定义 `Authorization` header，JWT 只能放 query；
「未授权拒连」最干净的做法是在 **HTTP upgrade 阶段** 写回 401/403，而不是先建连再关。
直接持有 `fastify.server.on('upgrade')` 可完全控制握手响应与状态码。

### 15.2 握手安全（五道闸，顺序不可调换）

1. **路径**：只认精确 `/ws`，其余 upgrade 直接断开（当前无第二个 upgrade handler）。
2. **Origin 白名单**：与 `CORS_ORIGIN` 共用配置，防跨站 WebSocket 劫持（CSWSH）；
   不带 Origin 的非浏览器客户端（E2E / 服务端脚本）放行。
3. **JWT**：从 query `token` 取，`fastify.jwt.verify` 验签；缺失 / 篡改 / 过期 → `401 UNAUTHORIZED`。
4. **账号状态**：与 HTTP 认证守卫同一口径，实时 `getAccountState()` 查库；
   不存在 → 401，封号 → `403 ACCOUNT_BANNED`（带中文原因），封号必须即时生效。
5. **连接数**：单账号上限 3，超限 → `429 TOO_MANY_CONNECTIONS`。

> 拒绝响应用 `socket.end(buildRejectResponse(...))` 一次性写完再关闭；
> `write` 后立刻 `destroy` 可能丢掉未 flush 的 body，客户端只能看到断连、拿不到机器码。

### 15.3 消息协议与保活

- 控制消息：`hello`（protocol / connectionId / userId / serverTime / heartbeatMs）、
  `ping` → `pong`（回显 ts）、`error`（code + 中文原因）、`bye`（reason + 可选 code）。
- **P2-1 不承载任何游戏状态**：业务消息与状态广播留到 P2-2 `GameSession`，
  不要现在就设计一套用不上的假协议。
- 单消息上限 4KB（`maxPayload` + 纯函数双保险）、单连接每秒最多 20 条，超限关闭 1008。
- 服务端每 30s 发底层 `ping`，两个周期无 `pong` 判定死连接并 `terminate`；
  心跳扫描顺带批量复查在线账号是否被封，被封则发 `bye`(`code=ACCOUNT_BANNED`) + 关闭 1008。
- 前端：指数退避 1/2/4/8/15s + 抖动；`online` / 页面重新可见立即重连；
  握手失败时用 `api.me()` 区分 401 / 封号（停止重连并交给全局弹窗）与网络故障（继续重连）；
  超过两个心跳周期收不到任何消息则主动断开触发重连。

### 15.4 测试与能力边界

- 后端单测：`backend/tests/wsProtocol.test.ts`（协议 + 登记表，含死连接 / 广播 / 上限）。
- E2E：`npm run e2e:p21`（需服务已起），覆盖握手、鉴权、封号、限流、坏包、重连、REST 回归。
- UI：`scripts/ui_smoke_p21.mjs`（headless Edge 375px），
  「实时通道已连接」文案来自 `useWsStatus()`，可证明浏览器真的完成了握手。
- **边界**：P2-1 只是通道；在线权威态、状态广播由 P2-2 补齐（见 §16），多人同屏仍属 P4，不要夸大本层能力。

---

## 16. P2-2 GameSession 在线权威态（2026-11-07）

> 任务表验收口径：「按用户的内存态 + DB 持久化；在线状态；状态变更服务端写入」。
> 实施原则：**不新增 Prisma 迁移、不动 `SCHEMA_VERSION`、不改写 P1-2 的三分支裁决逻辑**，
> 只把「裁决 / 整包 PUT 成功后的写库」这一步收敛到唯一入口。

### 16.1 状态模型与生命周期

- `lib/gameSession.ts`：`GameSessionRegistry` 按 `userId:slot` 维护内存态
  （`data` / `schemaVersion` / `clientId` / `authority` / `updatedAt` / `connections`）。
  纯逻辑、零依赖，`node:test` 可注入时间直接覆盖。
- DB 持久化仍用既有 `Save` 表（`data` + `authority`）；**revision 复用 `authority.revision`**，
  `monotonicAuthority()` 保证任何一次服务端写入至少 +1。连接建立时 `hydrateForUser()`
  从 DB 恢复三个槽位；最后一个连接断开后按 `SESSION_TTL_MS`（10 分钟）保留，
  心跳扫描 `sweepSessions()` 回收空会话，封号 `dropUserSessions()` 立即清理。
- `modules/sessionBus.ts` 放 `WsRegistry` + `GameSessionRegistry` 两个共享单例，
  消除 `realtime.ts ↔ session.ts` 的循环依赖；`getSessionStats()` 供 health 使用。

### 16.2 唯一写入口与协议

- `modules/session.ts::commitState()`：`prisma.save.upsert` → 更新内存态 →
  `broadcastToUser()` 推 `session.state`。`PUT /api/save` 与 `POST /api/actions/:type`
  均改调它；`GET /api/save` 在线时直接读内存权威态，`GET /api/session?slot=`
  返回在线 / revision / 连接数，`GET /api/health` 增加 `sessions` 统计。
- 下行 `session.state`：`{ slot, revision, data, updatedAt, schemaVersion, source, online }`
  全量快照（`source` = hydrate / put / intent）。**下行不受上行 4KB `maxPayload` 约束**；
  `hello.capabilities` 声明 `session.state` / `session.resync`，协议版本仍为 1。
- 上行只有 `ping` 与 `session.resync`（可带 slot，只请求重推快照）。
  **客户端不能通过 WS 写状态**：伪造 `session.state` 上行被 `UNKNOWN_TYPE` 拒绝并关闭 1008；
  所有状态变更必须经 REST 的意图裁决 / 整包 PUT，由服务端校验后统一写入。
- 广播给该账号所有在线连接（含发起端）。前端用 revision 幂等判断：本端 PUT 成功后
  `noteRevision()`，自己的回显版本相同即忽略；其它端的更新才应用。

### 16.3 前端接入与回环防护

- `lib/sessionState.ts`（零依赖）保存已见 revision / 意图在途计数 / 暂存快照，
  避免 `ws.ts` / `sync.ts` / `intents.ts` / `session.ts` 之间循环导入。
- `lib/ws.ts` 只校验并派发 `mpk:session-state`；`lib/session.ts` 幂等应用快照，
  应用前先 `suppressNextUpload()`，避免「收快照 → 自动 PUT → 再广播」多端回环；
  `intents.ts` 在发意图到 commitIntent 期间暂存快照，结束后再按 revision 补应用。
- `Start.tsx` 增加「在线权威态 rev=N」状态行；`App.tsx` 挂 `<SessionBootstrap/>`。

### 16.4 验收与边界

- `npm run e2e:p22` **24/24 `E2E_P22_OK`**：hydrate 快照、多端广播、revision 单调、
  GET 内存态、`session.resync`、伪造上行被拒且状态不变、意图登记与提交各广播一次、
  断线保留、重连拉最新、REST 回归。后端 `node:test` **107/107**、前端 vitest **47/47**、
  headless 375px **15/15**；原 57 / 38 / 34 三组 E2E 无回归。
- **能力边界**：本层只把「在线那份权威存档」收敛到服务端。战斗中间态 / HP / PP、
  遭遇生成、内容表 ID 真值仍在客户端；GG 改内存、加速器仍需 P3-1 服务端模拟根治。
  P2-2 是 P3 的前置，不等于客户端已成为瘦终端。

## 17. P3-1 服务端战斗（2026-11-07）

### 17.1 内容表：单一真源 + 生成，不手工复制

- 真源仍是 `src/game/data.ts`（+ 迁入的 `TYPE_CHART`）。后端 `rootDir=src` 不能跨包 import，
  所以用 `backend/scripts/gen-content.ts` 生成 `backend/src/game/content.generated.ts`：
  294 技能 / 40 幻兽 / 22 道具 / 8 遭遇主题 / 7 城镇 / 18 属性克制表。
- 命令：`npm run gen:content` 生成、`npm run check:content` 比对。
  **改了 `data.ts` 必须重新生成并一起提交**，否则 check 失败——这是防「服务端内容表慢慢过期」的唯一手段。
- `TYPE_CHART` 特意从 `rules.ts` 移到 `data.ts`：它是纯数据，放在 data 里生成器只依赖一个文件，
  不触发 `@/` 运行时别名（`rules.ts` 转出同名常量，旧引用不变）。

### 17.2 战斗内核（`backend/src/game/`）

| 文件 | 职责 |
|---|---|
| `content.ts` | 类型化访问内容表 + `effectiveness` / `contentStats` / `emptyMods` |
| `rules.ts` | 伤害、命中、暴击、速度、PP 推导、异常判定、能力变化、升级、捕获率；**所有随机走注入 `Rng`** |
| `battle.ts` | 状态机：开局 → 技能/道具/换人/捕获/逃跑 → 回合末 DOT → 结算（经验分配、奖励、首通） |

- **公式必须与前端 `src/game/rules.ts` 逐项一致**。`tests/battleEngine.test.ts` 直接 import 前端规则做对照：
  PP 294 项、克制全表、伤害数值、捕获率。任何一侧改公式而另一侧没跟上，单测立即失败。
- 服务端不读客户端任何数值：队伍/背包/等级来自存档，敌方由服务端 `createInstance` 生成，
  `captureRate` 从内容表读并按 `0.02~0.62` 钳制。

### 17.3 权威战斗态与接口

- `lib/battleSession.ts`：`BattleRegistry` 按 `(userId, slot)` 注册，**三键（userId+slot+battleId）全对才返回**，
  同槽位新开局覆盖旧战斗，`TTL=30min`，封号时 `dropUser`。
- 接口（全部要 JWT）：
  - `POST /api/battle/start` `{slot, theme, areaName, areaId?, levelMin, levelMax}` → 服务端生成敌人，返回 `battle`；
  - `POST /api/battle/action` `{battleId, slot, action}`，`action` 只能是
    `move{moveId}` / `item{itemId}` / `capture{itemId}` / `switch{partyIndex}` / `flee`；
  - `GET /api/battle/current?slot=`、`POST /api/battle/abandon`。
- **HTTP 状态约定**：参数不合法 400（带 `code`：`MOVE_UNKNOWN` / `PP_EXHAUSTED` / `ITEM_NOT_ENOUGH` /
  `SAME_ACTIVE` / `MONSTER_FAINTED` …）；战斗不存在或已结束 404 `BATTLE_NOT_FOUND`；
  战斗已结束再动作 409 `BATTLE_FINISHED`；单场动作超过 500 次 429。
- 结算：`applySettlement()` 用服务端战斗态覆盖存档——队伍 HP/经验/等级、金钱（`amulet_coin` 翻倍）、
  道具消耗（`state.consumed`）、捕获入队/入箱、图鉴 seen/captured、首通 `clearedAreas`，
  然后 `commitState(..., source='battle')` 写库并把 `authority.expected` 提到新档摘要、`revision+1`、`pending=null`。
  这样客户端后续再整包 PUT 也只是「不得更富」，无法抹掉战斗结果或凭空加资源。
- 广播：向下行推 `battle.state`（`battleId/turn/finished/result`），`hello.capabilities` 已声明；
  战斗结束后还会有一条 `session.state`（结算后的新存档）。**上行仍无任何写入口**。

### 17.4 验收与能力边界

- `npm run e2e:p31` **39/39 `E2E_P31_OK`**：敌人生成、队伍取自存档、PP 服务端扣减、换人、多回合、
  WS 广播、结算写档 revision 提升、伪造/越权 battleId 404、同槽位覆盖、放弃、跨账号隔离。
- 后端 `node:test` **130/130**（新增内核 15 例 + 注册表 8 例）、前端 47/47、三组旧 E2E 无回归。
- **边界（不要说成已完全瘦终端）**：
  1. 前端**还没切换**到服务端战斗（P3-1c）——当前玩家仍走本地战斗，服务端战斗能力处于「已就绪未接入」；
  2. 战斗会话在内存，服务重启即丢（客户端重新开局），不跨实例——P4 多人前要换成共享存储；
  3. `areaId` 匹配不到服务端地图时退化为信任客户端 theme（仍校验 theme 在真值表内），
     等级区间以服务端地图为准只在匹配成功时生效；
  4. 加速器仍可能影响客户端动画节奏，但**不再影响结算**（回合与 RNG 都在服务端）。

## 18. 测试体系与可重复验收（2026-11-07）

### 18.1 分层与分工

| 层 | 位置 | 命令 | 作用 |
|---|---|---|---|
| 纯函数单测 | `backend/tests/*.test.ts` | `npm test` | 规则/校验/权威摘要/会话注册表，注入 RNG，毫秒级 |
| 数值矩阵 | `backend/tests/numericRules.test.ts` | 同上 | **不变量与边界**，不绑定具体数值，调平衡不失效 |
| 公式对照 | `backend/tests/battleEngine.test.ts` | 同上 | 直接 import 前端 `rules.ts` 逐项比对，防两套引擎分叉 |
| 常规 E2E | `backend/tests/e2e_*.mjs` | `npm run e2e[:p12/p21/p22/p31]` | 正常路径与功能完整性，需服务在跑 |
| 对抗 E2E | `backend/tests/e2e_hardening.mjs` | `npm run e2e:hardening` | **攻击面**：伪造/越权/改档/重放/协议滥用 |
| 浏览器冒烟 | `scripts/ui_smoke_p21.mjs` | `node scripts/ui_smoke_p21.mjs` | 375px 真实渲染、WS 连接、权威快照 |
| 统一编排 | `scripts/verify.mjs` | `npm run verify` | 15 阶段串起以上全部 + 文档自检 |

**新增测试必须先想清楚放哪一层**：能用纯函数验证的不要起服务；攻击面用例一律进 `e2e_hardening`，
不要散落到常规 E2E 里（否则正常路径失败和对抗失败混在一起，定位成本高）。

### 18.2 共享底座 `tests/lib/harness.mjs`

新套件只写用例，不再复制 helper。提供：

- `api(path, {method, token, body, bodyText})`：统一返回 `{status, data, text}`，支持原始大 body（测 413）；
- `newAccount(prefix)` / `login` / `setRole` / `forgeToken(payload, {expiresInMs})`：
  账号与 JWT 伪造（负 `expiresInMs` 造过期 token；`fast-jwt` 不接受负 `expiresIn`，内部改写 `exp` 声明）；
- `validSave(overrides)` / `save.put|get|session` / `battle.start|action|current|abandon`；
- `openWs` / `waitMsg` / `waitClose` / `closeWs` / `sendRaw`：`openWs` 会通过 `unexpected-response`
  读回 401/403/429 的 JSON body，`waitClose` 读取记录的 `closeInfo`（连接可能已先关闭）；
- `Suite`：`[PASS]` / `[FAIL]` / `[SKIP]` + `<NAME>_RESULT` + `<NAME>_OK`，失败自动 `exit 1`；
- `cleanupAccounts(names)` / `cleanupByPrefix(prefixes, {dryRun})`：只删测试账号，**永不删 admin**。

### 18.3 对抗套件七分区（112 项）

| 分区 | 数量 | 关键断言 |
|---|---|---|
| A 认证与会话 | 16 | 无/乱码/篡改/过期/幽灵账号 token 全 401；跨账号隔离；注册长度约束；JWT 伪造 role 不生效 |
| B 存档结构 | 11 | 8 类结构非法 400 **不封号**、版本过高 `VERSION_TOO_NEW`、空 data 400、2MB 413、连打后仍可写 |
| C 风控封号 | 19 | 6 类改档特征 403 `ACCOUNT_BANNED`；封号后 GET/PUT/login/WS/意图全拒 |
| D 权威增量 | 14 | 加钱/加道具/撤销消耗 400 `AUTHORITY_MISMATCH`；伪造 nonce 400；重放 409；管理员授权链路 |
| E WS 攻防 | 12 | 无 token 401 / 非法 Origin 403 / 伪造上行 1008 / 超 4KB 1009 / 第 4 连接 429 / 限流 1008 |
| F 战斗接口 | 20 | 伪造与越权 battleId 404、未掌握技能/越界换人/不存在道具 400、伪造 HP 被忽略、放弃后 404 |
| G 数值边界 | 20 | 七组「合法线放行 / 超一线封号」成对断言；未来时间戳被钳制且不封号 |

**写法约定**：每项必须断言 `status` **和**机器码（`code`），只断 200/400 会漏掉错误码回归；
涉及 RNG 的只断区间与不变量，绝不写死等值（bug_log §20）。

### 18.4 统一编排 `npm run verify`

- 15 阶段约 35s；`--only=check,unit`（不需要服务）/ `--only=e2e:hardening` / `--skip=e2e,smoke`；
  `--strict` 让「服务没起」变成失败（CI 用）；`--no-clean` 保留测试账号排查。
- 编排器先探活 3001/5173，缺服务的阶段标 `SKIP` 而非失败，避免本地没起服务时一片红。
- 跑完自动执行 `clean:e2e`，防止 dev.db 被临时账号撑大；报告写 `.verify-report.json`（已 gitignore）。

### 18.5 已修缺陷与风控码约定

2026-11-07 杰哥拍板修复两项，细节见 `bug_log.md` §21 / §22，此处只留工程约定。

**① 幻兽个体值区间（已修，bug_log §21）**
原 `initMin = base + 3.2/2.3/2.0`，与内容表 `initStatsMax`（`base+0~5`）相减令 38 只 144 项
`initMin > initMax`，实测带宽均值仅 1.6、最窄 0；并让 `remapByBounds` 的 `oldMax <= oldMin`
分支恒命中，**进化时个体差异被清零**。现约定：

- `initMin` **必须等于种族值**，不得再叠加任何魔法偏移（`numericRules.test.ts` 硬断言）。
- `initMax = max(spec.initStatsMax?.x ?? 0, initMin.x + INIT_SPREAD_MIN)`，`INIT_SPREAD_MIN = 4`。
  内容表可以给更宽（HP 普遍 +5），但不能窄于保底。
- 前后端 `rules.ts` 两处 `getMonsterStatBounds` 必须同步改，公式对照由 `battleEngine.test.ts` 兜。
- 新增幻兽只填 `base*` 与 `initStatsMax`，不要动 `getMonsterStatBounds` 里的算式。

**② 风控 code 命名约定（已落地，bug_log §22）**
一个 code 只能表达一件事，**语义粒度 = 封号决策的粒度**：

| 后缀 | 含义 | 处置 | 在 `CHEAT_CODES` |
|---|---|---|---|
| `_FORMAT` | 类型 / 符号 / 整数性错误（脏档、旧版迁移、客户端 bug） | 400 拒绝 | ❌ 绝不封号 |
| `_RANGE` | 数值合法但超过上界（正常逻辑不可能产生） | 400 拒绝 + 封号 | ✅ |
| 容量类（`MONSTER_MOVES_MAX` / `INVENTORY_KEYS` …） | 条目数超规则上限 | 400 + 封号 | ✅ |
| `_HIGH` / `_OVERFLOW` 软告警 | 合法但高到只有测试菜单/外挂能造 | 封号 | ✅ |

- `MONSTER_HP_EXCEED`（hp > maxHp）属内部矛盾/脏档，**不在**白名单。
- 格式脏档任何账号（含管理员）都不入库；管理员放行的只是「数值偏高」。
- 新增字段务必拆两个 code；`antiCheat.test.ts` 会双向校验 14 个格式码 `false`、19 个越界码 `true`，
  且 `CHEAT_CODES.size` 精确相等——漏同步会被这条用例挡住。

**遗留风险（未改，杰哥策略）**：`MONEY_HIGH` 阈值 `MONEY_WARN = 999_999` 与前端测试菜单
`addMoney` 上限相同，意味着正常攒到 100 万即触发封号。目前按「改数据一律封」的强度保留，
长线运营前建议按道具单价与消耗速度重算该阈值。

## 19. P3-1c 前端接入服务端战斗的契约（2026-11-07）

战斗过程上移服务端之后，客户端从「算战斗」变成「发意图 + 渲染状态」。这一节记录
两侧必须同时遵守的约定，改任何一边都要回头看另一边界。

### 19.1 请求 / 响应契约

| 接口 | 谁调用 | 关键点 |
|---|---|---|
| `POST /api/battle/start` | `store.startEncounter` | 客户端只说明「在哪打」（theme / areaName / areaId / 等级区间）；`areaId` 能对上服务端地图时，等级区间以服务端为准 |
| `POST /api/battle/action` | `store.useMove` / `useItem` / `switchTo` / `flee` | 动作只有 5 种：`move` / `item` / `capture` / `switch` / `flee`；越权 `battleId` 一律 404 |
| `GET /api/battle/current` | `store.resumeBattle` | 刷新 / 断线重连后取回；战斗态**不进存档**，所以刷新只能靠它 |
| `POST /api/battle/abandon` | `store.leaveBattle` | 中途离开必须显式放弃，否则服务端会话挂到 30min TTL |

`battleView()` 下发的内容（P3-1c 扩展过，勿随意裁剪）：

- `party`：**我方队伍完整个体**（`moveIds` / 六维 / `initStats` / `growthRates` 全在）。
  战斗内的 HP / 经验只存在于这份副本里，UI 必须用它渲染，不能用存档里的队伍。
- `levelMin` / `levelMax`：前端「继续探索」要按同难度再开一场。
- `enemy` / `ppByMonster` / `log` / `turn` / `playerActiveIndex` / `playerMods` / `enemyMods`。
- `rewards` / `captured` / `consumed`：结算结果，供 UI 展示。

### 19.2 四条硬约束（踩了就出问题）

1. **战斗中不写 save**。把服务端下发的 HP 降、经验涨写进 `save1` 会触发自动上传；
   服务端只在结算时才认可这些变化，中途上传必然撞 `AUTHORITY_MISMATCH`。
   我方真值放 `battle.serverParty`，`save` 保持战前状态直到结算快照到达。

2. **权威快照不打断战斗**。`importSaveJson()` 默认 `battle: null`（换档语义），
   `lib/session.ts` 应用快照时必须传 `{ keepBattle: true }`。
   否则结算广播到达的瞬间 UI 会从战斗画面跳回「尚未开始遭遇」。

3. **没有任何降级**（2026-11-07 改）。战斗只有服务端一条路：未登录 / 网络不通 / 5xx
   一律如实报错，`startEncounter` 返回「网络中断，战斗需要连接服务端」。
   原先在 `toFailure(e).transient` 时降级本地战斗的分支已删除，原因见 §19.5。

4. **动作在途不重复发**。`battle.pending` 置位期间所有按钮 disabled。
   连点两次会把同一回合打两遍（服务端按动作序列推进，不认「同一次点击」）。

### 19.3 管理员测试标记

原先 `testShiny` / `testMaxStats` / `testOHKO` 只在客户端生效，战斗上移后必须由服务端处理：

- `start` 接受可选 `testFlags`，服务端**查库确认 `role === 'admin'`** 才应用；
- 普通账号传了**静默忽略**（不报错、不封号）——客户端硬编码测试开关不该升级成风控事件；
- 三者都等价实现，不给战斗内核开后门：`testOHKO` = 敌方开场 1 HP（不是「玩家必定一击」）；
- 生效时往战斗日志追加 `［管理员测试标记：…］`，便于排查「为什么这只怪这么强」。
- `e2e:p31` 的 H 区用 Prisma 直连提权来验证「身份由服务端判定」，不信任客户端自称。

### 19.4 测试分层

| 层 | 文件 | 覆盖什么 |
|---|---|---|
| 映射纯函数 | `src/lib/battleApi.test.ts`（12） | `toBattleState` 字段对齐 / `toFailure` 降级判定 |
| 接线 | `src/stores/battleFlow.test.ts`（20） | 五入口分流、防连点、BATTLE_NOT_FOUND、网络抖动不下算、结算拉档、abandon、resume |
| 接口契约 | `backend/tests/e2e_p31_battle.mjs` H 区（9） | 下发字段完整、管理员标记双向 |
| 真浏览器 | `scripts/ui_smoke_p31c.mjs`（15） | 点按钮 → 发意图 → 服务端结算 → 存档真的变了 |

单测是 mock 掉 api 的，证明「分流写对了」；只有 `ui_smoke_p31c` 能证明整条链路活着，
所以它不能省。改动战斗相关代码后至少跑 `npm run verify -- --only=smoke` 复查。

### 19.5 为什么不做离线降级（2026-11-07 定，杰哥拍板）

P3-1c 第一版留了「网络层失败 → 本地战斗」的降级。评估后删除，理由分三层：

**1. 收益侧本来就走不通，但代价很实在。** 本地战斗打完会把存档改富（经验、金钱、
捕获、首通区域），而服务端 `expected` 还是战前摘要 → `compareDigest` 判定变富 →
400 `AUTHORITY_MISMATCH`。`classifyUploadError` 把 4xx 判为 **permanent**、不入离线队列，
但**本地那份富档还在**：下一次、下下一次自动上传全部 400。
玩家看到的是「打完了、UI 给了奖励、联网后档案回滚，而且之后一直同步不上」。
这不是安全漏洞，是比漏洞更常见的数据可靠性故障。

**2. 它撑不起「离线也能玩」的承诺。** 断网时意图也发不出去，奖励、捕获、首通全都无效，
玩家实际上只能打一场不算数的仗。与其假装能玩，不如明确告知。

**3. 它保留了一整套可被改写的战斗实现。** `store` 里约 550 行本地战斗逻辑（`executeMoveAction`
/ `processEndOfTurn` / `runEnemyTurn` / `beginLocalEncounter`）是 GG 改内存最舒服的落点。
虽然改完的收益会被服务端拒掉，但只要将来有一处同步校验放松，它就是后门；
平时则要维护前后端两份规则（靠 `battleEngine.test.ts` 逐项对照兜着，那是成本不是资产）。

**当前策略**：未登录 → 「尚未登录，战斗需要连接服务端」；网络不通 / 5xx → 「网络中断，
战斗需要连接服务端。请检查网络后重试」。战斗中掉线不降级，用 `GET /api/battle/current`
（`store.resumeBattle`）恢复。

> 若将来真要做离线玩法，正确形态是**演练模式**：本地打、**不写存档、不给奖励**，
> UI 明确标「演练不计进度」。不能是「本地结算 + 联网补提交」——那条路必然对不上账。

### 19.6 `battle_reward` / `capture` 意图下线（同批）

这两个意图是 P1-2 的产物：那时战斗在客户端跑，服务端只能采信上报的过程数据。
`settlements.ts` 里 `battle_reward` 直接拿 `payload.enemyLevel` 算钱和经验的写法：

```ts
const enemyLevel = clamp(int(payload.enemyLevel, 1), 1, 30);
const expGain = 10 + enemyLevel * 6;
const moneyGain = (50 + enemyLevel * 10) * (hasAmuletCoin ? 2 : 1);
```

**没有任何「这场战斗真的发生过」的校验**，`modules/actions.ts` 里也没有战斗前置条件。
P3-1c 之后战斗已经上移，这条链路就成了零成本刷资源的口子：任何登录账号反复
`POST /api/actions/battle_reward { enemyLevel: 30 }` 即可每次拿 350 金币 + 190 经验，
nonce 每次新发不触发重放。`capture` 同型（采信 `baseRate` / `enemyHp` / `enemyStatus`）。

处理：从 `INTENT_TYPES` 移除、删除两个分支、删除只为其服务的 `CAPTURE_MODIFIER` /
`computeCaptureChance` / `statusMultiplier` / `BASE_RATE_MAX`。**不留兼容开关**——
开发阶段没有真实老客户端，「保留旧链路避免老客户端不可用」是无意义判断。

同时补回一处静默回退：`computeCaptureChance` 里的**稀有度打折**与**等级差修正**（P1-3）
在 P3-1c 迁到 `game/rules.ts::captureChance` 时没有跟过去，导致服务端战斗的捕获率
退回「只看残血和球」。现在两项并入 `captureChance(enemy, baseRate, device, playerAvgLevel)`，
前后端同步，`numericRules.test.ts` 用硬断言钉住（稀有度 ×0.92、等级压制上限 +10%）。

**教训**：删掉一个入口之前，先确认它承载的规则有没有别的落点。这次差点连规则一起删了。
