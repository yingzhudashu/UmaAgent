import { type ReactNode, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";
export function useOperation() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; detail: string; call: () => unknown }>();
  async function execute(call: () => unknown): Promise<boolean> {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await call();
      setConfirmation(undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请刷新状态核实后重试");
      setConfirmation(undefined);
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const feedback: ReactNode = (
    <>
      {busy && <output>正在处理，请稍候…</output>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirmation && (
        <ConfirmDialog
          title={confirmation.title}
          busy={busy}
          danger
          cancel={() => setConfirmation(undefined)}
          confirm={() => void execute(confirmation.call)}
        >
          {confirmation.detail}
        </ConfirmDialog>
      )}
    </>
  );
  return {
    busy,
    feedback,
    execute,
    confirm: (title: string, detail: string, call: () => unknown) => setConfirmation({ title, detail, call }),
  };
}
