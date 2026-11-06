import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { Info } from "lucide-react";
import Start from "@/pages/Start";
import Camp from "@/pages/Camp";
import Arena from "@/pages/Arena";
import Auth from "@/pages/Auth";
import { MoveLearnerModal } from "@/components/MoveLearnerModal";
import { EvolutionModal } from "@/components/EvolutionModal";
import MechanicsModal from "@/components/MechanicsModal";
import MoveChartModal from "@/components/MoveChartModal";
import { isLoggedIn, clearToken } from "@/lib/auth";
import { UNAUTHORIZED_EVENT, BANNED_EVENT } from "@/lib/api";
import { startAutoSync } from "@/lib/sync";
import PixelButton from "@/components/PixelButton";

// 未登录一律先去登录页；登录完成后由 Auth 页 navigate("/") 回到游戏。
function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  if (!isLoggedIn()) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

// 已登录时不再显示登录页，避免重复登录。
function GuestOnly({ children }: { children: ReactNode }) {
  return isLoggedIn() ? <Navigate to="/" replace /> : <>{children}</>;
}

// 登录态失效（401）统一处理：清 token 并跳登录页。必须在 <Router> 内部使用 useNavigate。
function UnauthorizedListener() {
  const navigate = useNavigate();
  useEffect(() => {
    const onUnauthorized = () => {
      clearToken();
      navigate("/auth", { replace: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate]);
  return null;
}

// 封号弹窗（P1-1b）：服务端检测到改档时全局展示，确认后清 token 并退回登录页。
// 放在 <Routes> 之外，路由切换不会卸载；小 max-w + overflow-auto + 长文案换行适配窄屏。
function BanGate() {
  const navigate = useNavigate();
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    const onBanned = (e: Event) => {
      const detail = (e as CustomEvent<{ reason?: string }>).detail;
      setReason(detail?.reason || "检测到异常游戏数据");
    };
    window.addEventListener(BANNED_EVENT, onBanned);
    return () => window.removeEventListener(BANNED_EVENT, onBanned);
  }, []);

  if (!reason) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ban-title"
    >
      <div className="max-h-[85vh] w-full max-w-sm overflow-auto border-2 border-[color:var(--danger)] bg-[color:var(--bg)] p-5 text-center shadow-2xl">
        <div id="ban-title" className="font-display text-lg leading-relaxed text-[color:var(--danger)]">
          你已被封号
        </div>
        <p className="mt-3 text-sm leading-relaxed text-[color:var(--text)]">
          检测到异常游戏数据，账号已被停止服务并退出登录。
        </p>
        <p className="mt-2 break-words text-xs leading-relaxed text-[color:var(--muted)]">{reason}</p>
        <div className="mt-5">
          <PixelButton
            tone="danger"
            onClick={() => {
              clearToken();
              setReason(null);
              navigate("/auth", { replace: true });
            }}
          >
            确定并退出登录
          </PixelButton>
        </div>
      </div>
    </div>
  );
}

// 启动自动云同步：订阅 store 变更做防抖上传、监听网络恢复重传。无 UI，仅副作用。
function SyncBootstrap() {
  useEffect(() => {
    startAutoSync();
  }, []);
  return null;
}

export default function App() {
  const [showMechanics, setShowMechanics] = useState(false);
  const [showMoveChart, setShowMoveChart] = useState(false);

  return (
    <Router>
      <UnauthorizedListener />
      <BanGate />
      <SyncBootstrap />
      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <Start />
            </RequireAuth>
          }
        />
        <Route
          path="/camp"
          element={
            <RequireAuth>
              <Camp onShowMechanics={() => setShowMechanics(true)} onShowMoveChart={() => setShowMoveChart(true)} />
            </RequireAuth>
          }
        />
        <Route
          path="/arena"
          element={
            <RequireAuth>
              <Arena onShowMechanics={() => setShowMechanics(true)} onShowMoveChart={() => setShowMoveChart(true)} />
            </RequireAuth>
          }
        />
        <Route
          path="/auth"
          element={
            <GuestOnly>
              <Auth />
            </GuestOnly>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <MoveLearnerModal />
      <EvolutionModal />
      {showMechanics && <MechanicsModal onClose={() => setShowMechanics(false)} />}
      {showMoveChart && <MoveChartModal onClose={() => setShowMoveChart(false)} />}
    </Router>
  );
}
