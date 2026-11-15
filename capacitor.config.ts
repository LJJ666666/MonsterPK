import type { CapacitorConfig } from '@capacitor/cli';

// 构建期开关（MPK_DEV_APK=1）：仅本地调试 APK 使用。WebView 改走 http scheme 并允许明文，
// 以便把业务请求发到宿主机的 http://localhost:3001（靠 adb reverse 回连）。
// 正式包（P5-3）不带此开关：Capacitor 默认 androidScheme=https
// （源码实证 @capacitor/android CapConfig.java 的 CAPACITOR_HTTPS_SCHEME），
// WebView origin = https://localhost，必须列入后端 CORS_ORIGIN；
// 业务地址由构建期 VITE_API_BASE 注入 HTTPS 域名，REST 与 WS 共用一份 API_BASE。
// 明文流量只由 android/app/src/debug/AndroidManifest.xml 在 debug 变体放行。
const devApk = process.env.MPK_DEV_APK === '1';

const config: CapacitorConfig = {
  appId: 'com.monster.game',
  appName: '兽域手记',
  webDir: 'dist',
  ...(devApk
    ? {
        server: {
          androidScheme: 'http',
          cleartext: true,
          allowMixedContent: true,
        },
      }
    : {}),
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      // 枚举按「文字颜色」命名：Style.Dark = "DARK" = 深色背景配浅色图标。
      // Android 实现为 setAppearanceLightStatusBars(!style.equals("DARK"))，
      // 传 LIGHT 反而会变成深色图标、在 #070a14 上不可读。
      style: 'DARK',
      backgroundColor: '#070a14'
    }
  }
};

export default config;
