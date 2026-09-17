import { type ReactNode, useEffect, useId, useRef } from "react";
export function ConfirmDialog({
  title,
  children,
  busy = false,
  danger = false,
  cancelLabel = "取消",
  confirmLabel = "确认",
  cancel,
  confirm,
}: {
  title: string;
  children: ReactNode;
  busy?: boolean;
  danger?: boolean;
  cancelLabel?: string;
  confirmLabel?: string;
  cancel: () => void;
  confirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    back.current?.focus();
    return () => {
      dialog?.close();
      before?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="design-confirm"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) cancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <div>{children}</div>
      <div className="dialog-actions">
        <button ref={back} type="button" disabled={busy} onClick={cancel}>
          {cancelLabel}
        </button>
        <button type="button" className={danger ? "danger" : "primary"} disabled={busy} onClick={confirm}>
          {busy ? "处理中…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
