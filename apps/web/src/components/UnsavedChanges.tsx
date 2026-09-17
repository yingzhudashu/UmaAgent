import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "./ConfirmDialog.js";

type FormState = { dirty: boolean; discard: () => void };
type Guard = { forms: Map<object, FormState>; request: (action: () => void, only?: object) => void };
const Context = createContext<Guard | undefined>(undefined);

/** 仅登记挂载中的编辑表单；聊天草稿由独立持久化模块负责，不在此处丢弃。 */
export function UnsavedChanges({ children }: { children: ReactNode }) {
  const forms = useRef(new Map<object, FormState>()).current;
  const host = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<{ action: () => void; keys: object[] }>();
  const request = useCallback(
    (action: () => void, only?: object) => {
      const keys = [...forms]
        .filter(([key, form]) => form.dirty && (!only || key === only))
        .map(([key]) => key);
      if (keys.length) setPending({ action, keys });
      else action();
    },
    [forms],
  );
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (![...forms.values()].some((form) => form.dirty)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [forms]);
  return (
    <Context.Provider value={{ forms, request }}>
      <div ref={host} style={{ display: "contents" }}>
        {children}
      </div>
      {pending &&
        createPortal(
          <ConfirmDialog
            title="放弃未保存内容？"
            cancelLabel="继续编辑"
            confirmLabel="放弃并离开"
            cancel={() => setPending(undefined)}
            confirm={() => {
              const { action, keys } = pending;
              setPending(undefined);
              // 先清除脏标记，嵌套导航不会针对已明确放弃的修改重复弹窗。
              for (const key of keys) {
                const form = forms.get(key);
                if (form?.dirty) {
                  form.dirty = false;
                  form.discard();
                }
              }
              action();
            }}
          >
            离开后，本次未保存的修改将丢失。取消可继续编辑。
          </ConfirmDialog>,
          host.current?.querySelector("[data-design-shell='UmaAgent']") as HTMLElement,
        )}
    </Context.Provider>
  );
}

export function useLeaveConfirmation() {
  const guard = useContext(Context);
  if (!guard) throw new Error("编辑页面必须位于 UnsavedChanges 中");
  return guard.request;
}

export function useUnsavedForm(dirty: boolean, discard: () => void) {
  const guard = useContext(Context);
  const forms = guard?.forms;
  const key = useRef({}).current;
  useEffect(() => {
    if (!forms) return;
    forms.set(key, { dirty, discard });
    return () => {
      forms.delete(key);
    };
  }, [forms, key, dirty, discard]);
  return (action: () => void) => {
    if (!guard) throw new Error("编辑页面必须位于 UnsavedChanges 中");
    guard.request(action, key);
  };
}
