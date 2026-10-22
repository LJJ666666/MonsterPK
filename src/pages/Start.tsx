import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import PixelButton from "@/components/PixelButton";
import PixelCard from "@/components/PixelCard";
import { MONSTER_SPECS, STARTERS } from "@/game/data";
import { useGameStore } from "@/stores/useGameStore";

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Start() {
  const navigate = useNavigate();
  const { save1, save2, save3, slot, setSlot, newGame, resetSave, importSaveJson, exportSaveJson } = useGameStore();
  const [open, setOpen] = useState(false);
  const [playerName, setPlayerName] = useState("旅行者");
  const [starter, setStarter] = useState<(typeof STARTERS)[number]>(STARTERS[0]);
  const [err, setErr] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  const starterList = useMemo(
    () => STARTERS.map((id) => ({ id, spec: MONSTER_SPECS[id] })),
    []
  );

  const saves = [save1, save2, save3];
  const activeSave = saves[slot - 1];

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-md flex-col bg-[color:var(--bg)] shadow-2xl sm:border-x-2 sm:border-[color:var(--stroke)] overflow-y-auto">
      <div className="flex-none px-5 py-6">
        <div className="mb-6 flex flex-col gap-2">
          <div>
            <div className="font-display text-3xl tracking-[0.2em] text-[color:var(--text)]">兽域手记</div>
            <div className="mt-2 text-sm leading-relaxed text-[color:var(--muted)]">
              原创抓怪回合制RPG原型。
            </div>
          </div>
          <div className="text-xs text-[color:var(--muted)]">
            <div>离线存档 · 可导入导出</div>
            <div className="mt-1">多槽位支持 (3个)</div>
          </div>
        </div>

        <div className="grid gap-4">
          <PixelCard title="选择存档槽位">
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map((s) => {
                const sv = saves[s - 1];
                return (
                  <button
                    key={s}
                    onClick={() => {
                      setSlot(s as 1 | 2 | 3);
                      setErr(null);
                    }}
                    className={[
                      "flex flex-col items-start justify-center border-2 px-3 py-2 text-left transition-colors",
                      s === slot
                        ? "border-[color:var(--accent)] bg-[color:var(--panel2)]"
                        : "border-[color:var(--stroke)] bg-[color:var(--bg2)] hover:bg-[color:var(--panel2)]",
                    ].join(" ")}
                  >
                    <div className="font-semibold text-[color:var(--text)]">槽位 {s}</div>
                    {sv ? (
                      <div className="mt-1 text-xs text-[color:var(--muted)]">
                        {sv.playerName} · 金钱 ¥{sv.money} · {Object.values(sv.collection).filter(x => x.captured).length} 捕获
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-[color:var(--muted)] opacity-60">空</div>
                    )}
                  </button>
                );
              })}
            </div>
          </PixelCard>

          <PixelCard title={`操作 (槽位 ${slot})`} right={activeSave ? `玩家：${activeSave.playerName}` : "空"}>
            <div className="flex flex-col gap-2">
              {!activeSave ? (
                <PixelButton onClick={() => setOpen(true)}>创建新游戏</PixelButton>
              ) : (
                <PixelButton onClick={() => navigate("/camp")} tone="primary">
                  继续游戏
                </PixelButton>
              )}
              
              <div className="mt-1 grid grid-cols-2 gap-2">
                <PixelButton
                  tone="muted"
                  onClick={() => {
                    setErr(null);
                    importRef.current?.click();
                  }}
                >
                  导入
                </PixelButton>
                <PixelButton
                  tone="muted"
                  disabled={!activeSave}
                  onClick={() => {
                    const res = exportSaveJson();
                    if (res.ok === false) {
                      setErr(res.reason);
                      return;
                    }
                    downloadText(`beast-journal-save-slot${slot}-${Date.now()}.json`, res.json);
                  }}
                >
                  导出
                </PixelButton>
              </div>
              <div className="mt-1">
                <PixelButton
                  tone="danger"
                  disabled={!activeSave}
                  onClick={() => {
                    if (confirm(`确定要清空槽位 ${slot} 的存档吗？这无法撤销。`)) {
                      resetSave();
                      setErr(null);
                    }
                  }}
                >
                  清空
                </PixelButton>
              </div>
              {err && <div className="mt-2 text-xs text-[color:var(--danger)]">{err}</div>}
            </div>
          </PixelCard>
        </div>
      </div>

      <input
        ref={importRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const text = await f.text();
          const res = importSaveJson(text);
          if (res.ok === false) {
            setErr(res.reason);
            return;
          }
          setErr(null);
          navigate("/camp");
        }}
      />

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-2xl">
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
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <div className="text-xs text-[color:var(--muted)]">玩家名</div>
                  <input
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    className="mt-2 w-full border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] px-3 py-2 text-sm text-[color:var(--text)] outline-none focus:border-[color:var(--accent)]"
                    maxLength={12}
                  />
                  <div className="mt-6 text-xs text-[color:var(--muted)]">初始伙伴（三选一）</div>
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
                <div className="flex flex-col justify-between gap-4">
                  <div className="rounded border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-4 text-sm text-[color:var(--muted)]">
                    <div className="font-semibold text-[color:var(--text)]">起始物资</div>
                    <div className="mt-2 space-y-1">
                      <div>捕获胶囊 ×6</div>
                      <div>棱镜胶囊 ×1</div>
                      <div>小型修复剂 ×3</div>
                    </div>
                  </div>
                  <PixelButton
                    onClick={() => {
                      const name = playerName.trim() || "旅行者";
                      newGame(name, starter);
                      setOpen(false);
                      navigate("/camp");
                    }}
                  >
                    开始旅程
                  </PixelButton>
                </div>
              </div>
            </PixelCard>
          </div>
        </div>
      )}
    </div>
  );
}
