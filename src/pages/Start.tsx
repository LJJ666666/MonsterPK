import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import PixelButton from "@/components/PixelButton";
import PixelCard from "@/components/PixelCard";
import BrandMark from "@/components/BrandMark";
import { MONSTER_SPECS, STARTERS } from "@/game/data";
import { useGameStore } from "@/stores/useGameStore";
import { api } from "@/lib/api";
import { clearToken } from "@/lib/auth";
import { useSyncStatus, type SyncPhase } from "@/lib/sync";
import { useIsAdmin } from "@/lib/admin";
import { useWsStatus, type WsPhase } from "@/lib/ws";
import { useSessionStatus } from "@/lib/session";

type CloudState = "checking" | "none" | "available" | "unreachable";

const cloudText: Record<CloudState, string> = {
  checking: "正在检查云端存档…",
  none: "云端暂无备份",
  available: "云端已有备份",
  unreachable: "无法连接服务器",
};

// 写通道状态（意图裁决结果的提交相位）：只在玩家执行操作时变化。
const syncText: Record<SyncPhase, string> = {
  idle: "提交通道未启用",
  submitting: "正在提交到服务端…",
  committed: "已提交至服务端",
  error: "提交出错",
};
const syncColor: Record<SyncPhase, string> = {
  idle: "bg-[color:var(--muted)]",
  submitting: "bg-[color:var(--accent)]",
  committed: "bg-[color:var(--ok)]",
  error: "bg-[color:var(--danger)]",
};
// 实时通道状态（P2-1）：只显示连接相位，与存档同步状态分开，便于分别排障。
const wsText: Record<WsPhase, string> = {
  idle: "实时通道未启动",
  connecting: "正在连接实时通道…",
  online: "实时通道已连接",
  reconnecting: "实时连接中断，正在重连…",
  offline: "实时通道暂不可用",
  unauthorized: "实时连接未授权",
};
const wsColor: Record<WsPhase, string> = {
  idle: "bg-[color:var(--muted)]",
  connecting: "bg-[color:var(--accent)]",
  online: "bg-[color:var(--ok)]",
  reconnecting: "bg-[color:var(--accent)]",
  offline: "bg-[color:var(--danger)]",
  unauthorized: "bg-[color:var(--danger)]",
};

export default function Start() {
  const navigate = useNavigate();
  const { save, newGame } = useGameStore();
  const activeSave = save;

  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [playerName, setPlayerName] = useState("旅行者");
  const [starter, setStarter] = useState<(typeof STARTERS)[number]>(STARTERS[0]);
  const [err, setErr] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [cloud, setCloud] = useState<CloudState>("checking");
  const { phase, info } = useSyncStatus();
  const isAdmin = useIsAdmin();
  const { phase: wsPhase, info: wsInfo } = useWsStatus();
  const sessionView = useSessionStatus();

  // 读取当前账号名 + 探测云端是否有备份（只读，不覆盖本地进度）。
  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((u) => {
        if (alive) setUsername(u?.username ?? "");
      })
      .catch((e: any) => {
        if (e?.status === 401) {
          clearToken();
          navigate("/auth", { replace: true });
        }
      });
    api
      .getSave()
      .then(() => {
        if (alive) setCloud("available");
      })
      .catch((e: any) => {
        if (alive) setCloud(e?.status === 404 ? "none" : "unreachable");
      });
    return () => {
      alive = false;
    };
  }, [navigate]);

  const starterList = useMemo(
    () => STARTERS.map((id) => ({ id, spec: MONSTER_SPECS[id] })),
    []
  );
  const captured = activeSave
    ? Object.values(activeSave.collection).filter((x: any) => x.captured).length
    : 0;

  function logout() {
    clearToken();
    navigate("/auth", { replace: true });
  }

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-y-auto bg-[color:var(--bg)] shadow-2xl safe-top sm:border-x-2 sm:border-[color:var(--stroke)]">
      {/* 账号条 */}
      <header className="flex flex-none items-center justify-between border-b-2 border-[color:var(--stroke2)] px-5 py-4">
        <div className="flex items-center gap-3">
          <BrandMark className="h-9 w-9 shrink-0" />
          <div>
            <div className="font-display text-xs tracking-[0.1em] text-[color:var(--accent)]">
              兽域手记
            </div>
            <div className="mt-1 text-[10px] tracking-[0.2em] text-[color:var(--muted)] opacity-70">
              BEAST JOURNAL
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-xs text-[color:var(--text)]">{username || "旅行者"}</span>
            {isAdmin && (
              <span className="border border-[color:var(--accent)] px-1 text-[9px] leading-4 text-[color:var(--accent)]">
                管理员
              </span>
            )}
          </div>
          <button
            onClick={logout}
            className="mt-1 text-[11px] text-[color:var(--muted)] underline decoration-dotted hover:text-[color:var(--text)]"
          >
            退出登录
          </button>
        </div>
      </header>

      <main className="flex-1 px-5 py-8">
        <div className="text-[11px] tracking-[0.22em] text-[color:var(--muted)] opacity-80">
          FIELD JOURNAL / 001
        </div>
        <h1 className="mt-3 font-display text-xl leading-relaxed tracking-[0.08em] text-[color:var(--text)]">
          野外考察，
          <br />
          从这里继续。
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-[color:var(--muted)]">
          捕捉、培养、记录每一只幻兽。进度跟随你的账号保存。
        </p>

        {/* 进度摘要：只读展示 */}
        <div className="mt-8 border-l-2 border-[color:var(--accent)] pl-4">
          <div className="text-xs text-[color:var(--muted)]">当前进度</div>
          {activeSave ? (
            <>
              <div className="mt-1 text-base font-semibold text-[color:var(--text)]">
                {activeSave.playerName}
              </div>
              <div className="mt-1 text-xs text-[color:var(--muted)]">
                金钱 ¥{activeSave.money} · 已捕获 {captured} 只
              </div>
            </>
          ) : (
            <div className="mt-1 text-sm text-[color:var(--muted)] opacity-70">
              尚无冒险记录，选一只伙伴出发吧。
            </div>
          )}
        </div>

        {/* 唯一主操作 */}
        <button
          onClick={() => (activeSave ? navigate("/camp") : setOpen(true))}
          className="mt-8 w-full border-2 border-[color:var(--accent)] bg-[color:var(--accent)] px-4 py-3 text-sm font-semibold tracking-wide text-[#0b1020] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--text)]"
        >
          {activeSave ? "继续旅程" : "开始新旅程"}
        </button>

        {/* 云端状态 */}
        <div className="mt-4 flex items-center gap-2 text-xs text-[color:var(--muted)]">
          <span
            className={[
              "inline-block h-2 w-2 shrink-0",
              cloud === "available"
                ? "bg-[color:var(--ok)]"
                : cloud === "unreachable"
                  ? "bg-[color:var(--danger)]"
                  : "bg-[color:var(--muted)]",
            ].join(" ")}
          />
          <span>{cloudText[cloud]}</span>
        </div>

        {/* 写通道状态：意图裁决结果的提交相位。
            error 相位附带服务端中文拒绝原因；长文案需换行，保持移动端不横向溢出。 */}
        <div className="mt-2 flex items-start gap-2 text-xs text-[color:var(--muted)]">
          <span
            className={[
              "mt-1 inline-block h-2 w-2 shrink-0",
              syncColor[phase] ?? "bg-[color:var(--muted)]",
            ].join(" ")}
          />
          <span className="min-w-0 break-words leading-relaxed">
            {phase === "error" && info ? `提交出错：${info}` : (syncText[phase] ?? "提交通道未启用")}
          </span>
        </div>

        {/* 实时通道状态（P2-1）：重连倒计时 / 中文原因长文案需换行，避免窄屏横向溢出。 */}
        <div className="mt-2 flex items-start gap-2 text-xs text-[color:var(--muted)]">
          <span
            className={[
              "mt-1 inline-block h-2 w-2 shrink-0",
              wsColor[wsPhase] ?? "bg-[color:var(--muted)]",
            ].join(" ")}
          />
          <span className="min-w-0 break-words leading-relaxed">
            {wsPhase === "reconnecting" && wsInfo
              ? `${wsText[wsPhase]}（${wsInfo}）`
              : (wsText[wsPhase] ?? "实时通道未启动")}
          </span>
        </div>

        {/* 在线权威态（P2-2）：rev 来自服务端 session.state 快照，长文案换行避免窄屏溢出。 */}
        <div className="mt-2 flex items-start gap-2 text-xs text-[color:var(--muted)]">
          <span
            className={[
              "mt-1 inline-block h-2 w-2 shrink-0",
              sessionView ? "bg-[color:var(--ok)]" : "bg-[color:var(--muted)]",
            ].join(" ")}
          />
          <span className="min-w-0 break-words leading-relaxed">
            {sessionView
              ? `在线权威态 rev=${sessionView.revision}（${sessionView.online} 端在线）`
              : "在线权威态：等待服务端快照"}
          </span>
        </div>

        {err && <div className="mt-4 text-xs text-[color:var(--danger)]">{err}</div>}

        {/* 次要操作折叠收纳，不占主界面 */}
        <div className="mt-10 border-t-2 border-[color:var(--stroke2)] pt-4">
          <button
            onClick={() => setAccountOpen(!accountOpen)}
            aria-expanded={accountOpen}
            className="flex w-full items-center justify-between text-xs text-[color:var(--muted)] hover:text-[color:var(--text)]"
          >
            <span>账号与存档</span>
            <span>{accountOpen ? "收起 −" : "展开 +"}</span>
          </button>
          {accountOpen && (
            <div className="mt-4 flex flex-col gap-3">
              <div className="text-[11px] leading-relaxed text-[color:var(--muted)] opacity-80">
                进度只保存在你的账号下（当前账号：{username || "旅行者"}），换设备登录即可继续。
              </div>
              <div className="grid grid-cols-2 gap-2">
                <PixelButton tone="muted" size="sm" onClick={logout}>
                  退出登录
                </PixelButton>
                <PixelButton
                  tone="danger"
                  size="sm"
                  disabled={!activeSave}
                  onClick={() => {
                    // P5：本地存档已删除，「清空内存」不再有任何意义（服务端那份才是真值，
                    // 刷新就回来）。重开必须走服务端 new_game 覆盖，这里换个入口而已。
                    if (confirm("确定重新开始吗？当前存档会被新档覆盖，无法撤销。")) {
                      setOpen(true);
                    }
                  }}
                >
                  重新开始
                </PixelButton>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 创建新档弹窗（游戏必要流程，保留） */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="max-h-[85dvh] w-full max-w-md overflow-y-auto">
            <PixelCard
              title="创建新档"
              right={
                <button
                  className="text-xs text-[color:var(--muted)] hover:text-[color:var(--text)]"
                  onClick={() => setOpen(false)}
                >
                  关闭
                </button>
              }
            >
              <div className="flex flex-col gap-5">
                <div>
                  <div className="text-xs text-[color:var(--muted)]">玩家名</div>
                  <input
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    className="mt-2 w-full border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] px-3 py-2 text-sm text-[color:var(--text)] outline-none focus:border-[color:var(--accent)]"
                    maxLength={12}
                  />
                </div>
                <div>
                  <div className="text-xs text-[color:var(--muted)]">初始伙伴（三选一）</div>
                  <div className="mt-2 grid gap-2">
                    {starterList.map((x) => (
                      <button
                        key={x.id}
                        onClick={() => setStarter(x.id)}
                        className={[
                          "flex items-center justify-between border-2 px-3 py-2 text-left text-sm",
                          x.id === starter
                            ? "border-[color:var(--accent)] bg-[color:var(--panel2)] text-[color:var(--text)]"
                            : "border-[color:var(--stroke)] bg-[color:var(--bg2)] text-[color:var(--muted)] hover:text-[color:var(--text)]",
                        ].join(" ")}
                      >
                        <span className="font-semibold">{x.spec.name}</span>
                        <span className="text-xs">属性 {x.spec.element.toUpperCase()}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3 text-xs text-[color:var(--muted)]">
                  <div className="font-semibold text-[color:var(--text)]">起始物资</div>
                  <div className="mt-1.5">捕获胶囊 ×6 · 棱镜胶囊 ×1 · 小型修复剂 ×3</div>
                </div>
                <PixelButton
                  onClick={async () => {
                    const name = playerName.trim() || "旅行者";
                    // P3-2b：新档由服务端生成，客户端只提交名字与初始幻兽。
                    const res = await newGame(name, starter);
                    if (!res.ok) {
                      setErr(res.reason ?? "创建存档失败");
                      return;
                    }
                    setOpen(false);
                    navigate("/camp");
                  }}
                >
                  开始旅程
                </PixelButton>
              </div>
            </PixelCard>
          </div>
        </div>
      )}
    </div>
  );
}
