/** 通用二次确认弹窗（替代浏览器原生 confirm —— WebView 里会弹系统级对话框，破坏游戏内观感）。
 *  基于 ModalShell：遮罩/ESC/焦点/背景滚动锁统一沿用；按钮用 PixelButton 保证触控区。
 *  主操作（确定）默认 danger 语义，因为现存 4 处确认全是「覆盖 / 放生 / 放弃收益」这类不可逆操作。 */
import ModalShell from "@/components/ModalShell";
import PixelButton from "@/components/PixelButton";

type Props = {
  title: string;
  message: string;
  onConfirm: () => void;
  onClose: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export default function ConfirmModal({
  title,
  message,
  onConfirm,
  onClose,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = true,
}: Props) {
  return (
    <ModalShell onClose={onClose} title={title} panelClassName="max-w-xs">
      <div className="modal-header">
        <div className="modal-title">{title}</div>
        <button type="button" onClick={onClose} aria-label="关闭" className="modal-close tap-expand">
          &times;
        </button>
      </div>
      <div className="modal-body p-4">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[color:var(--text)]">
          {message}
        </p>
      </div>
      <div className="modal-footer flex justify-end gap-2">
        <PixelButton tone="muted" size="sm" onClick={onClose}>
          {cancelLabel}
        </PixelButton>
        <PixelButton tone={danger ? "danger" : "primary"} size="sm" onClick={onConfirm}>
          {confirmLabel}
        </PixelButton>
      </div>
    </ModalShell>
  );
}
