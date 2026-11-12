import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from '@/components/ErrorBoundary'
import './index.css'

// 错误边界放在 App 外层（StrictMode 内层）：任一路由组件渲染期抛错都能兜住，
// 不会退化成 WebView 白屏；兜底页不碰本地存档，刷新后由服务端真值恢复。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
