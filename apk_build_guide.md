# 云端沙盒 Capacitor + Android SDK 编译 APK 指南

因为云端沙盒（Workspace）环境每次长时间休眠后会被重置，且默认不包含 Android SDK、Java 和 Gradle 环境。因此如果需要在云端直接编译打包 APK，需要通过以下完整流程从零配置。

## 1. 安装基础环境 (Java 21)

云端可能预装了不兼容的高版本 Java (如 25)，因此需要明确安装 JDK 21 并进行环境配置：

```bash
apt-get update && apt-get install -y openjdk-21-jdk unzip wget
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export PATH=$JAVA_HOME/bin:$PATH
```

## 2. 安装并配置 Android SDK

沙盒中默认没有 SDK，必须通过官方命令行工具拉取：

```bash
mkdir -p /opt/android-sdk/cmdline-tools
cd /opt/android-sdk/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdline-tools.zip
unzip -q cmdline-tools.zip
mv cmdline-tools latest
rm cmdline-tools.zip

# 接受所有霸王条款许可证
yes | /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses

# 安装平台工具、指定 Android 版本的 SDK (例如 36) 和 Build-tools (例如 35.0.0)
/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-36" "build-tools;35.0.0"

# 导出环境变量
export ANDROID_HOME=/opt/android-sdk
```

## 3. Capacitor 项目初始化

将 Web 项目构建后与原生 Android 工程同步：

```bash
cd /workspace
# 本项目已包含 Capacitor 依赖（见 package.json），通常无需重复安装
npx cap init "游戏名" "com.game.package" --web-dir dist

# 确保前端产物存在
npm run build

# 添加或同步 android 目录
rm -rf android  # 如果环境混乱，可以先删掉重建
npx cap add android
# 如果已经 add 过，就直接使用： npx cap sync
```

## 4. 解决 Gradle 网络墙与依赖超时问题 (关键)

由于沙盒处于特定的网络环境中，Gradle 自动拉取发行包和访问 Google Maven 仓库会超时失败，必须通过代理或手动下载的方式解决。

### 4.1 手动配置 Gradle 发行版离线包
```bash
cd /workspace
# 下载 Gradle (如果超时可以换用腾讯云镜像)
wget -q --show-progress https://services.gradle.org/distributions/gradle-8.14.3-all.zip || wget -q --show-progress https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-all.zip

# 修改 wrapper 属性，指向本地文件
cd /workspace/android
sed -i "s|distributionUrl=.*|distributionUrl=file:///workspace/gradle-8.14.3-all.zip|g" gradle/wrapper/gradle-wrapper.properties
```

### 4.2 穿透代理执行编译
执行 `./gradlew assembleDebug` 时，需要带上沙盒的本地代理端口（例如 `18080`），并建议关闭守护进程避免卡死：

```bash
cd /workspace/android
# 清理缓存与停掉多余的守护进程防卡死
./gradlew --stop
rm -rf ~/.gradle/caches

# 开始编译（建议在同一个终端“同步阻塞”等待，直到看到 BUILD SUCCESSFUL）
./gradlew assembleDebug -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=18080 -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=18080 --no-daemon
```

### 4.3 Release 产物（可选）

如果需要 Release 包（未签名，仅验证流程），可用：

```bash
cd /workspace/android
./gradlew assembleRelease -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=18080 -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=18080 --no-daemon
```

## 5. 提取产物

当看到 `BUILD SUCCESSFUL` 后，APK 即打包完成。将深层目录中的 APK 提取到根目录方便下载：

```bash
cp /workspace/android/app/build/outputs/apk/debug/app-debug.apk /workspace/游戏-测试版.apk
```

---
**避坑总结：**
- **网络墙问题**：永远不要干等 Gradle 自己下载，必须配合 `wget` 本地替换并加上 `proxyHost` 代理运行。
- **JDK 版本不匹配**：Gradle 报错 `Unsupported class file major version` 时，通常是因为沙盒内的默认 JDK 太高或者太低。必须强制使用 `export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64`。
- **守护进程假死**：`--no-daemon` 或者在编译前执行 `./gradlew --stop` 可以避免因为守护进程内存溢出或卡死导致的构建无限期挂起。
