# APK 构建与 Release 发布指南（P5-3）

> 唯一权威入口。旧「云端沙盒 apt-get 装 JDK / sdkmanager 拉 SDK / gradlew 联网 / 18080 代理」流程
> 已废弃：2026-11-14 实测 gradlew 下载发行包卡在 60% 约 1h43m，本机直调离线 Gradle 只需 8~13s（bug_log §71）。

## 0. 三条硬约束

1. **凭据不入库**：keystore 与密码只从环境变量 / 用户级 `~/.gradle/gradle.properties` 读，仓库里只有模板与说明。
2. **正式包零调试选项**：release 不带 `MPK_DEV_APK`；`android/app/src/main/AndroidManifest.xml` 默认禁明文，只有 `src/debug/AndroidManifest.xml` 叠加放行。
3. **业务地址构建期注入**：`VITE_API_BASE` 必须是 HTTPS 域名。`src/lib/api.ts` 的 `API_BASE` 同时供 REST 与 `wsUrl()` 使用（https → wss），一处注入覆盖两条链路，`ws.test.ts` 已锁死。

## 1. 工具链（先核再用，勿猜）

**三条路径因机而异，本文不写死任何一台机器的盘符。** 开工前先跑一遍探明（Git Bash）：

```bash
# JDK 21：家里在 D:\jdk21\*，公司在 E:\Six\jdk\*，别的机器可能在 Program Files
ls -d /d/jdk21/*/bin/java.exe /e/Six/jdk/*/bin/java.exe 2>/dev/null
# Android SDK（含 platforms/android-36）
ls -d /d/android-sdk /e/Six/android-sdk 2>/dev/null
# 解压好的 Gradle 8.14.3 发行包（不是 wrapper 的 .gradle/wrapper/dists）
ls -d /e/Six/gradle-dist/gradle-8.14.3/bin/gradle /d/Six/gradle-dist/gradle-8.14.3/bin/gradle 2>/dev/null
# build-tools 实际版本（apksigner 在 <build-tools>/<ver>/lib/apksigner.jar）
ls -1 "${ANDROID_HOME:-/e/Six/android-sdk}/build-tools" 2>/dev/null
```

一次性设置（**不要**写 `android/local.properties`，不要改 `gradle-wrapper.properties` 去联网）。
下面四个值按上一步的实测结果替换，`<build-tools 版本>` 取 `ls` 出来的那一个：

```bash
export JAVA_HOME="/e/Six/jdk/jdk-21"                 # 家里：/d/jdk21/jdk-21.0.10+7
export ANDROID_HOME="/e/Six/android-sdk"             # 家里：/d/android-sdk
export GRADLE_BIN="/e/Six/gradle-dist/gradle-8.14.3/bin/gradle"
export GRADLE_USER_HOME="/e/Six/gradle-user-home"    # 有 AGP 依赖缓存，别用默认 ~/.gradle
export PATH="$JAVA_HOME/bin:$PATH"
```

> JDK 必须是 21（Capacitor 8 / AGP 8.13 用 `sourceCompatibility 21`）；系统 PATH 上的
> Temurin 17 会报 `错误: 无效的目标发行版: 21`。核验：`"$JAVA_HOME/bin/java" -version`。

所有 Gradle 命令一律 `"$GRADLE_BIN" -p android <task> --offline --console=plain --no-daemon`。

## 2. 前端产物与 Capacitor 同步

```bash
# debug（本地 adb reverse 回连 http://localhost:3001）
npm run build
MPK_DEV_APK=1 npx cap sync android

# release（生产 HTTPS 域名；域名由杰哥切云时提供）
VITE_API_BASE=https://api.example.com npm run build
npx cap sync android          # 注意：不带 MPK_DEV_APK
```

`MPK_DEV_APK=1` 只影响 `capacitor.config.ts` 生成的 `server` 段（http scheme / cleartext / mixed content）。
正式包不带这段，Capacitor 默认 `androidScheme=https`（源码实证 `CapConfig.java` 的
`CAPACITOR_HTTPS_SCHEME`），WebView origin = `https://localhost`。

取证：`unzip -p <apk> assets/capacitor.config.json` → debug 应有 `server` 段，release 必须没有。

## 3. 版本号

唯一真值在 `android/gradle.properties`：

```properties
mpkVersionCode=1
mpkVersionName=1.0
```

发版可用 `-P` 覆盖，不必改文件：

```bash
"$GRADLE_BIN" -p android assembleRelease --offline --console=plain --no-daemon \
  -PmpkVersionCode=2 -PmpkVersionName=1.0.0
```

用 `"$ANDROID_HOME/build-tools/<ver>/aapt.exe" dump badging <apk> | head -3` 核产物里的 `versionCode` / `versionName`。

## 4. Release 签名（fail-closed）

```bash
export MPK_KEYSTORE_FILE="<仓库外的 keystore 绝对路径>"
export MPK_KEYSTORE_PASSWORD="<store password>"
export MPK_KEY_ALIAS="<key alias>"
export MPK_KEY_PASSWORD="<key password>"

"$GRADLE_BIN" -p android assembleRelease --offline --console=plain --no-daemon -PmpkVersionCode=2 -PmpkVersionName=1.0.0
# 产物：android/app/build/outputs/apk/release/app-release.apk
```

`android/app/build.gradle` 在 task 图就绪时校验四要素与 keystore 文件存在性：
**缺任一项直接 `BUILD FAILED`，绝不产出 unsigned APK**（避免把未签名包误当渠道包）。debug 构建不受影响。

验签（`<ver>` 用 `ls "$ANDROID_HOME/build-tools"` 出来的值，家里 / 公司可能不同）：

```bash
java -jar "$ANDROID_HOME/build-tools/<ver>/lib/apksigner.jar" verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

## 5. 切云时的后端配套

`backend/.env`（项目层真值，gitignored）：

```dotenv
CORS_ORIGIN="https://app.example.com,https://localhost"
```

- 第二项是 Capacitor Android WebView 的默认 origin，**漏配会让正式包所有请求被拒**。
- HTTP CORS 与 WS 握手 Origin 共用这份逗号分隔清单，精确匹配；`'*'` 不是通配（杰哥 2026-11-15 拍板删通配，fail-closed）。
- 同时换：`JWT_SECRET`（随机长串）、`DATABASE_URL` / `REDIS_URL`（托管实例）、`JWT_TTL` 缩短；
  TLS 终止在反代 / CDN，WS `Upgrade` 必须透传（W9 `reverseProxy.mjs` 已具备）。
- 发奖 / 风控口径不变，切云只改地址与凭据，不改产品语义。

## 6. 产物取证清单（每次出包逐条核，只认产物不认日志尾）

| 项 | 命令 / 判据 |
|---|---|
| 产物新鲜度 | APK mtime + sha256；debug 增量构建内容未变时 mtime 可能保留，以内容为准 |
| 版本号 | `aapt dump badging <apk>` → `versionCode` / `versionName` 与本次发版一致 |
| 明文 | `aapt dump xmltree <apk> AndroidManifest.xml \| grep -i cleartext` → release **必须 NONE**，debug 必须 `0xffffffff` |
| 调试配置 | `unzip -p <apk> assets/capacitor.config.json` → release 无 `server` 段 |
| 业务地址 | `unzip -p <apk> "assets/public/assets/index-*.js" \| grep -o "https://api.example.com"` → release 命中 |
| 签名 | `apksigner verify --print-certs` 通过，证书 DN 与正式 keystore 一致 |
| 权限 / 包体 | `aapt dump badging <apk> \| grep -E "uses-permission|application-label"`；当前仅 `INTERNET`，包体记入发版记录 |

## 7. 发布前回归清单

- `npm run verify -- --strict`（**发布前默认口径**：前后端 dev 都起起来，全量含 UI 冒烟，0 跳过）。确实起不来前端 dev 时，只能显式跑 `npm run verify -- --only=check,unit,docs --strict` 并在发版记录里注明「冒烟未跑」，不得用 `--skip=smoke` 冒充全绿。
- 真机逐项：登录 → 建档 → 野外 → 战斗 → 捕获 → 队伍 → 冷启动拉服务端存档 → WS 实时 → 顶号 → 断网重连。
- CORS 反证：把 Origin 改成未列入的值，HTTP 与 WS 都必须拒绝。
- 低端 ARM 真机性能补测（`性能基线_web.md` §112 遗留项，P5-3 阶段补）。
- 发布前用正式域名 + 正式 keystore 重出包；**测试证书 / 占位域名不得进渠道包**。

## 8. 2026-11-15 实测记录（本机跑通，非可发布包）

| 变体 | capacitor.config.json | cleartext | 版本 | bundle API_BASE | 签名 |
|---|---|---|---|---|---|
| debug | 含 `server`（http / cleartext / mixed） | `usesCleartextTraffic=true` | `1` / `1.0` | `http://localhost:3001` | debug keystore |
| release | 无 `server` 段（默认 https） | **NONE** | `2` / `1.0.0`（`-P` 覆盖） | `https://api.example.com` | `apksigner verify` 通过（临时测试证书 `CN=MonsterPK Test`） |

- 缺签名材料反证：`BUILD FAILED in 6s`、退出码 1，错误信息明确列出四个变量名。
- 回归：前端 158/158、后端 503/503，全量 E2E（含 W9 `e2e:multi` 42/42、`e2e:game` 42/42、hardening 122）全绿，
  `DOC_CHECK_OK`、记忆镜像一致。
- release 包 API 地址是占位域名、证书是临时自签名，**仅用于验证签名 / 明文 / 注入链路，不能上线**。
