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
import { stopWriteChannel } from "@/lib/sync";
import { bootstrapSave } from "@/lib/saveBootstrap";
import { startRealtime, stopRealtime } from "@/lib/ws";
import { startSessionSync } from "@/lib/session";
import { SESSION_REPLACED_EVENT } from "@/lib/sessionReplaced";
import { setSessionSuspended } from "@/lib/sessionState";
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

// 顶号弹窗（P4-1a）：后来者登录 / 建连时，服务端把旧设备的会话作废。
// 这里先停掉实时通道与自动同步，本设备进入只读下线态；**不做任何本地改动合并**，
// 用户点确认后清 token 回登录页。弹窗显示期间不主动清 token，保证提示一定看得到。
function SessionGate() {
  const navigate = useNavigate();
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    const onReplaced = (e: Event) => {
      const detail = (e as CustomEvent<{ reason?: string }>).detail;
      setSessionSuspended(true);
      stopWriteChannel();
      stopRealtime();
      setReason(detail?.reason || "账号已在其他设备登录，本设备已下线");
    };
    window.addEventListener(SESSION_REPLACED_EVENT, onReplaced);
    return () => window.removeEventListener(SESSION_REPLACED_EVENT, onReplaced);
  }, []);

  if (!reason) return null;
  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="replaced-title"
    >
      <div className="max-h-[85vh] w-full max-w-sm overflow-auto border-2 border-[color:var(--accent)] bg-[color:var(--bg)] p-5 text-center shadow-2xl">
        <div id="replaced-title" className="font-display text-lg leading-relaxed text-[color:var(--accent)]">
          账号已在其他设备登录
        </div>
        <p className="mt-3 text-sm leading-relaxed text-[color:var(--text)]">
          为保证存档只有一份服务端真值，本设备已下线。本设备此后的任何操作都不会生效。
        </p>
        <p className="mt-2 break-words text-xs leading-relaxed text-[color:var(--muted)]">{reason}</p>
        <div className="mt-5">
          <PixelButton
            onClick={() => {
              clearToken();
              setReason(null);
              navigate("/auth", { replace: true });
            }}
          >
            重新登录
          </PixelButton>
        </div>
      </div>
    </div>
  );
}

/**
 * 启动加载闸门（P5）：本地存档已删除，登录态下 store 是空的，必须先问一次
 * `GET /api/save` 才知道这个账号有没有档。加载完成前不渲染路由——
 * 否则 Start 会先闪一屏「开始新旅程」、Camp 会因空档误判而跳回首页。
 * 未登录直接放行：登录页不需要存档。
 */
function BootGate({ children }: { children: ReactNode }) {
  const [booted, setBooted] = useState(!isLoggedIn());
  useEffect(() => {
    if (booted) return;
    let alive = true;
    // 顺序有讲究：先把 session.state 的 window 事件监听挂上，再建 WS。
    // WS 连上后服务端会立刻 hydrate 并推第一条权威快照；如果监听晚于它到达
    // （Router 内的 SessionBootstrap 此时还没渲染），这条快照会被静默丢掉，
    // Start 的「在线权威态」就永远停在「等待服务端快照」。
    startSessionSync();
    startRealtime();
    // 存档 GET 与建连并行：实时通道不依赖存档，不能被存档请求推迟
    // （房间/对战入口都要求「实时通道在线」）。
    void bootstrapSave().finally(() => {
      if (alive) setBooted(true);
    });
    return () => {
      alive = false;
    };
  }, [booted]);

  if (!booted) {
    return (
      <div
        className="flex h-[100dvh] w-full items-center justify-center bg-[color:var(--bg)]"
        data-boot="loading"
      >
        <div className="text-center">
          <div className="font-display text-sm tracking-[0.2em] text-[color:var(--accent)]">
            兽域手记
          </div>
          <div className="mt-3 text-xs text-[color:var(--muted)]">正在读取服务端存档…</div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

// 启动实时通道（P2-1）：只建连/保活/重连。依赖路由是为了登录/登出后重新建连。
function RealtimeBootstrap() {
  const location = useLocation();
  useEffect(() => {
    startRealtime();
  }, [location.pathname]);
  return null;
}

// 接入在线权威态（P2-2）：监听 session.state 快照，幂等应用并抑制自动回传。
// 必须在 RealtimeBootstrap 之前挂载无关紧要（事件监听是全局的），但放在同一层便于排障。
function SessionBootstrap() {
  useEffect(() => {
    startSessionSync();
  }, []);
  return null;
}

export default function App() {
  const [showMechanics, setShowMechanics] = useState(false);
  const [showMoveChart, setShowMoveChart] = useState(false);

  return (
    <BootGate>
      <Router>
        <UnauthorizedListener />
        <BanGate />
        <SessionGate />
        <SessionBootstrap />
        <RealtimeBootstrap />
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
    </BootGate>
  );
}
