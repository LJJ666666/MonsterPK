import type { CapacitorConfig } from '@capacitor/cli';

// 本地调试 APK 开关（MPK_DEV_APK=1）：WebView 走 http scheme 并允许明文，
// 以便把业务请求发到宿主机的 http://<局域网IP>:3001 后端。
// 默认不设置时行为零变更，正式包（P5-3）不会带上这些调试选项。
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
      style: 'DARK',
      backgroundColor: '#070a14'
    }
  }
};

export default config;
