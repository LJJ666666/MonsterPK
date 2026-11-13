import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import BrandMark from "@/components/BrandMark";
import { api, API_BASE } from "@/lib/api";
import { setToken } from "@/lib/auth";
import { bootstrapSave } from "@/lib/saveBootstrap";

type Mode = "login" | "register";
type FieldErrors = { username?: string; password?: string; confirm?: string };
type ServiceState = "checking" | "online" | "offline";

const LAST_USER_KEY = "mpk_last_username";

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
      <div className="mt-1.5">{children}</div>
      {error ? (
        <div className="mt-1.5 text-xs text-[color:var(--danger)]" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="mt-1.5 text-[11px] text-[color:var(--muted)] opacity-70">{hint}</div>
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

  // 后端可达性探测：连不上时给明确提示，避免用户对着白屏猜。
  useEffect(() => {
    let alive = true;
    api
      .health()
      .then(() => alive && setService("online"))
      .catch(() => alive && setService("offline"));
    return () => {
      alive = false;
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
      setToken(res.token);
      // 登录后立刻把服务端存档拉下来（本地没有任何副本，这是唯一的来源）。
      // 必须等它完成再跳转，否则 Start 会先闪一屏「开始新旅程」。
      await bootstrapSave();
      if (remember) localStorage.setItem(LAST_USER_KEY, username.trim());
      else localStorage.removeItem(LAST_USER_KEY);
      navigate("/", { replace: true });
    } catch (e: any) {
      const raw = e?.message || "";
      setFormError(
        /failed to fetch|networkerror|load failed/i.test(raw)
          ? "连不上服务器，请确认后端服务已启动"
          : raw || "操作失败，请稍后再试"
      );
    } finally {
      setBusy(false);
    }
  }

  const serviceText: Record<ServiceState, string> = {
    checking: "正在连接服务器…",
    online: "服务器在线",
    offline: "连不上服务器 · 请确认后端服务已启动",
  };

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-[color:var(--bg)] shadow-2xl sm:border-x-2 sm:border-[color:var(--stroke)]">
      {/* 品牌区 */}
      <header className="flex-none px-6 pt-10 pb-7">
        <div className="flex items-center gap-4">
          <BrandMark className="h-14 w-14 shrink-0" />
          <div>
            <div className="font-display text-lg tracking-[0.1em] text-[color:var(--accent)]">
              兽域手记
            </div>
            <div className="mt-2 text-[11px] tracking-[0.28em] text-[color:var(--muted)]">
              BEAST JOURNAL
            </div>
          </div>
        </div>
        <p className="mt-6 text-sm leading-relaxed text-[color:var(--muted)]">
          登录账号，继续你的野外考察与幻兽收集之旅。
        </p>
        <div className="mt-6 h-[2px] w-full bg-[color:var(--stroke2)]" />
      </header>

      <main className="flex-1 overflow-y-auto px-6 pb-10">
        {/* 登录 / 注册分段切换 */}
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
                "py-2.5 text-sm font-semibold tracking-wide transition-colors",
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

        <div className="mt-6 text-lg font-semibold text-[color:var(--text)]">
          {mode === "login" ? "欢迎回来，旅行者" : "创建你的冒险账号"}
        </div>
        <div className="mt-1 text-xs text-[color:var(--muted)]">
          {mode === "login"
            ? "进度跟随账号，换设备也能接着玩"
            : "注册后自动登录，立即开始旅程"}
        </div>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
          <Field
            label="用户名"
            htmlFor="auth-username"
            error={errors.username}
            hint={mode === "register" ? "3–20 位，字母、数字或中文" : undefined}
          >
            <input
              id="auth-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
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
            label="密码"
            htmlFor="auth-password"
            error={errors.password}
            hint={mode === "register" ? "至少 6 位" : undefined}
          >
            <div className="relative">
              <input
                id="auth-password"
                type={showPwd ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
                autoComplete="new-password"
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
            className="mt-1 w-full border-2 border-[color:var(--accent)] bg-[color:var(--accent)] px-4 py-3 text-sm font-semibold tracking-wide text-[#0b1020] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "请稍候…" : mode === "login" ? "登录并继续" : "创建账号并进入"}
          </button>
        </form>

        {/* 服务状态 */}
        <div className="mt-8 flex items-center gap-2 text-xs text-[color:var(--muted)]">
          <span
            className={[
              "inline-block h-2 w-2 shrink-0",
              service === "online"
                ? "bg-[color:var(--ok)]"
                : service === "offline"
                  ? "bg-[color:var(--danger)]"
                  : "bg-[color:var(--muted)]",
            ].join(" ")}
          />
          <span>{serviceText[service]}</span>
        </div>
        <div className="mt-2 text-[11px] text-[color:var(--muted)] opacity-60">
          API · {API_BASE}
        </div>
      </main>
    </div>
  );
}
