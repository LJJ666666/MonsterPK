import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent, FormEvent, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import BrandMark from "@/components/BrandMark";
import DragonTotem from "@/components/DragonTotem";
import { api } from "@/lib/api";
import { setToken } from "@/lib/auth";
import { bootstrapSave } from "@/lib/saveBootstrap";
import { signOut } from "@/lib/accountSwitch";

type Mode = "login" | "register";
type FieldErrors = { username?: string; password?: string; confirm?: string };
type ServiceState = "checking" | "online" | "offline";

const LAST_USER_KEY = "mpk_last_username";

// 登录 / 注册共用一套排版：顶部品牌区、tab、标题（含右侧服务红绿灯）位置在切换时完全不动，
// 只有中间表单按内容自然增减（注册多一个「确认密码」）。360×616 真机两态及报错态都不滚动。
const inputBase =
  "w-full border-2 bg-[color:var(--bg2)] px-3 py-2.5 text-sm text-[color:var(--text)] outline-none transition-colors " +
  "placeholder:text-[color:var(--muted)] placeholder:opacity-50 focus:border-[color:var(--accent)]";

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs tracking-wide text-[color:var(--muted)]">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {error ? (
        <div className="mt-1 text-xs text-[color:var(--danger)]" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="mt-1 text-[11px] text-[color:var(--muted)] opacity-90">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export default function Auth() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState(
    () => localStorage.getItem(LAST_USER_KEY) ?? ""
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [remember, setRemember] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [service, setService] = useState<ServiceState>("checking");
  const [forgotHint, setForgotHint] = useState(false);

  // P1 键盘避让（Android adjustResize / iOS WKWebView 通用）：
  // 1) 输入框聚焦时把字段滚入可视区中部；
  // 2) 软键盘弹起常晚于 focus，监听 visualViewport.resize 再滚一次；
  // 3) 仅在真的溢出（键盘占屏）时才滚，一屏装得下时完全不动，避免无谓跳动。
  // adjustResize（Capacitor 常用）：视口收窄触发本逻辑；adjustPan 下浏览器原生平移兜底。
  const shellRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<HTMLElement | null>(null);
  const revealFocused = useCallback(() => {
    const shell = shellRef.current;
    const el = focusedRef.current;
    if (!shell || !el) return;
    if (shell.scrollHeight <= shell.clientHeight + 1) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    vv.addEventListener("resize", revealFocused);
    return () => vv.removeEventListener("resize", revealFocused);
  }, [revealFocused]);

  const handleFocus = useCallback(
    (e: FocusEvent<HTMLInputElement>) => {
      focusedRef.current = e.currentTarget;
      revealFocused();
    },
    [revealFocused]
  );

  // 后端可达性持续嗅探：连不上时给明确提示并自动重试，而不是只首次监听一次。
  // 每 3s 轮询一次，在线后保持在线态；一旦失败再由 offline 转回重试，
  // 这样后端中途重启 / 手机切后台回来都能自动恢复，无需用户手动刷新。
  useEffect(() => {
    let alive = true;
    let inFlight = false; // 断网时 fetch 可能悬挂，避免 3s 轮询叠加出一堆请求
    const probe = () => {
      if (inFlight) return;
      inFlight = true;
      api
        .health({ timeoutMs: 2500 })
        .then(() => alive && setService("online"))
        .catch(() => alive && setService("offline"))
        .finally(() => {
          inFlight = false;
        });
    };
    setService("checking");
    probe();
    const timer = setInterval(probe, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setErrors({});
    setFormError(null);
    setConfirm("");
    setPassword("");
    setForgotHint(false);
  }

  function validate(): boolean {
    const next: FieldErrors = {};
    const name = username.trim();
    if (!name) next.username = "请输入用户名";
    else if (mode === "register" && (name.length < 3 || name.length > 20))
      next.username = "用户名需 3–20 位";
    if (!password) next.password = "请输入密码";
    else if (mode === "register" && (password.length < 6 || password.length > 64))
      next.password = "密码需 6–64 位";
    if (mode === "register" && confirm !== password)
      next.confirm = "两次输入的密码不一致";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setForgotHint(false);
    if (!validate()) return;
    if (service === "offline") {
      setFormError("连不上服务器，请确认后端服务已启动后重试");
      return;
    }
    setBusy(true);
    try {
      const res =
        mode === "login"
          ? await api.login(username.trim(), password)
          : await api.register(username.trim(), password);
      // 账号边界：先把上一个账号的内存渲染副本 / revision / 实时通道清干净。
      // 否则新账号若没有存档，会继续显示旧账号的图鉴与进度，写操作却全部 404。
      signOut();
      setToken(res.token);
      // 登录后立刻把服务端存档拉下来（本地没有任何副本，这是唯一的来源）。
      // 必须等它完成再跳转，否则 Start 会先闪一屏「开始新旅程」。
      await bootstrapSave();
      if (remember) localStorage.setItem(LAST_USER_KEY, username.trim());
      else localStorage.removeItem(LAST_USER_KEY);
      navigate("/", { replace: true });
    } catch (e: any) {
      const raw = e?.message || "";
      const isNet = /failed to fetch|networkerror|load failed/i.test(raw);
      // 网络层失败：立刻把服务态翻成 offline，驱动底部状态条与「自动重试」提示，
      // 持续嗅探会在后端恢复后自动翻回 online。
      if (isNet) setService("offline");
      setFormError(
        isNet
          ? "连不上服务器，请确认后端服务已启动（正在自动重试）"
          : raw || "操作失败，请稍后再试"
      );
    } finally {
      setBusy(false);
    }
  }

  const serviceText: Record<ServiceState, string> = {
    checking: "正在连接服务器…",
    online: "服务器在线",
    offline: "连不上服务器 · 正在自动重试",
  };

  return (
    // 安全区：只用真实 env(safe-area-inset-top)（非 overlay WebView 的状态栏在 WebView 外，
    // 再兜底 24px 会白占一屏高度）。整体一屏排布：品牌区 + 表单 + 状态栏贴底。
    // 登录 / 注册共用同一套结构，切换时各锚点位置不变，只有中间字段按内容增减。
    <div ref={shellRef} className="page-shell safe-top safe-bottom overflow-y-auto">
      {/* 品牌区：登录 / 注册完全一致，用登录页的丰富结构 */}
      <header className="flex-none px-6 pb-3">
        <div className="flex items-center gap-3">
          <BrandMark className="h-11 w-11 shrink-0" />
          <div>
            <div className="font-display text-base leading-none tracking-[0.1em] text-[color:var(--accent)]">
              兽域手记
            </div>
            <div className="mt-1.5 text-[11px] tracking-[0.28em] text-[color:var(--muted)]">
              BEAST JOURNAL
            </div>
          </div>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-[color:var(--muted)]">
          野外考察手记，陪你收集每一只幻兽。
        </p>
        <div className="mt-3 h-[2px] w-full bg-[color:var(--stroke2)]" />
      </header>

      <main className="flex flex-1 flex-col px-6">
        {/* tab + 标题：固定顶部，切换时不移动 */}
        <div className="flex-none">
          <div
            className="grid grid-cols-2 border-2 border-[color:var(--stroke)]"
            role="tablist"
            aria-label="账号操作"
          >
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                className={[
                  "min-h-[44px] py-2.5 text-sm font-semibold tracking-wide transition-colors",
                  m === "login" ? "border-r-2 border-[color:var(--stroke)]" : "",
                  mode === m
                    ? "bg-[color:var(--accent)] text-[#0b1020]"
                    : "bg-[color:var(--bg2)] text-[color:var(--muted)] hover:text-[color:var(--text)]",
                ].join(" ")}
              >
                {m === "login" ? "登录" : "注册"}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold text-[color:var(--text)]">
                {mode === "login" ? "欢迎回来，旅行者" : "创建你的冒险账号"}
              </div>
              <div className="mt-0.5 text-xs text-[color:var(--muted)]">
                {mode === "login"
                  ? "进度跟随账号，换设备也能接着玩"
                  : "注册后自动登录，立即开始旅程"}
              </div>
            </div>
            {/* 服务状态：标题右侧红绿灯，纯色点 + 无障碍标签，不再占底部一行 */}
            <span
              data-service-dot={service}
              role="status"
              aria-label={`服务器状态：${serviceText[service]}`}
              title={serviceText[service]}
              className={[
                "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
                service === "online"
                  ? "bg-[color:var(--ok)]"
                  : service === "offline"
                    ? "bg-[color:var(--danger)]"
                    : "bg-[color:var(--muted)] animate-pulse",
              ].join(" ")}
            />
          </div>
        </div>

        {/* 表单：顶部对齐自然延展，不做垂直居中，避免两态高度不同时整块漂移 */}
        <form onSubmit={submit} className="mt-3 flex flex-col gap-1.5" noValidate>
          <Field
            label="用户名 · 3–20 位"
            htmlFor="auth-username"
            error={errors.username}
          >
            <input
              id="auth-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onFocus={handleFocus}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={20}
              placeholder="请输入用户名"
              aria-invalid={!!errors.username}
              className={[
                inputBase,
                errors.username
                  ? "border-[color:var(--danger)]"
                  : "border-[color:var(--stroke)]",
              ].join(" ")}
            />
          </Field>

          <Field
            label="密码 · 至少 6 位"
            htmlFor="auth-password"
            error={errors.password}
          >
            <div className="relative">
              <input
                id="auth-password"
                type={showPwd ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={handleFocus}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                maxLength={64}
                placeholder="请输入密码"
                aria-invalid={!!errors.password}
                className={[
                  inputBase,
                  "pr-16",
                  errors.password
                    ? "border-[color:var(--danger)]"
                    : "border-[color:var(--stroke)]",
                ].join(" ")}
              />
              <button
                type="button"
                onClick={() => setShowPwd(!showPwd)}
                aria-label={showPwd ? "隐藏密码" : "显示密码"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[color:var(--muted)] hover:text-[color:var(--text)]"
              >
                {showPwd ? "隐藏" : "显示"}
              </button>
            </div>
          </Field>

          {mode === "register" && (
            <Field label="确认密码" htmlFor="auth-confirm" error={errors.confirm}>
              <input
                id="auth-confirm"
                type={showPwd ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onFocus={handleFocus}
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={64}
                placeholder="再输入一次密码"
                aria-invalid={!!errors.confirm}
                className={[
                  inputBase,
                  errors.confirm
                    ? "border-[color:var(--danger)]"
                    : "border-[color:var(--stroke)]",
                ].join(" ")}
              />
            </Field>
          )}

          {mode === "login" && (
            <div className="flex items-center justify-between text-xs">
              <label className="flex cursor-pointer items-center gap-2 text-[color:var(--muted)]">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 accent-[#f6c24b]"
                />
                记住用户名
              </label>
              <button
                type="button"
                onClick={() => setForgotHint(true)}
                className="text-[color:var(--muted)] underline decoration-dotted hover:text-[color:var(--text)]"
              >
                忘记密码？
              </button>
            </div>
          )}

          {forgotHint && (
            <div className="border-l-2 border-[color:var(--accent)] pl-3 text-xs leading-relaxed text-[color:var(--muted)]">
              暂未开放自助找回密码，请联系管理员处理。
            </div>
          )}

          {formError && (
            <div
              role="alert"
              className="border-2 border-[color:var(--danger)] bg-[color:var(--bg2)] px-3 py-2.5 text-xs leading-relaxed text-[color:var(--danger)]"
            >
              {formError}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 min-h-[48px] w-full border-2 border-[color:var(--accent)] bg-[color:var(--accent)] px-4 py-3 text-sm font-semibold tracking-wide text-[#0b1020] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "请稍候…" : mode === "login" ? "登录并继续" : "创建账号并进入"}
          </button>
        </form>

        {/* 留白区装饰：黑白水墨龙水印（本地透明 PNG）。flex-1 吸收剩余空间，报错态自动收缩不顶破一屏。
            object-contain 保持龙身比例，opacity 压成水印；纯装饰不参与可访问性树与点击。 */}
        <div className="relative min-h-0 flex-1 overflow-hidden" aria-hidden="true">
          <DragonTotem className="pointer-events-none absolute inset-0 m-auto h-full w-full object-contain object-center opacity-40" />
        </div>
      </main>
    </div>
  );
}
