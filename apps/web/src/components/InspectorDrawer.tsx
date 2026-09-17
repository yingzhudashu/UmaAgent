import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
export type InspectorSection = "connection" | "run" | "approvals" | "sync" | "settings";

const titles: Record<InspectorSection, string> = {
  connection: "Core 连接",
  run: "当前运行",
  approvals: "待审批",
  sync: "同步与连接",
  settings: "会话设置",
};

export function InspectorDrawer({
  inline = false,
  title,
  description,
  screen,
  openNavigation,
  section,
  onClose,
  children,
}: {
  inline?: boolean;
  title?: string | undefined;
  description?: string | undefined;
  screen?: string | undefined;
  openNavigation?: (() => void) | undefined;
  section: InspectorSection | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!section || inline) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      // 原生模态确认拥有自己的焦点与 Escape 处理，背后的抽屉不得抢先关闭。
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [
        ...drawerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!focusable.length) {
        event.preventDefault();
        drawerRef.current.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus({ preventScroll: true });
      returnFocusRef.current = null;
    };
  }, [onClose, section, inline]);
  if (!section) return null;
  if (inline)
    return (
      <section className="destination-workspace" data-design-page={screen}>
        <header className="destination-header">
          <button type="button" className="mobile-only" aria-label="打开导航" onClick={openNavigation}>
            导航
          </button>
          <div>
            <span className="eyebrow">UmaAgent</span>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          <button type="button" onClick={onClose}>
            返回会话
          </button>
        </header>
        <div className="destination-body">{children}</div>
      </section>
    );
  return (
    <>
      <button type="button" className="drawer-backdrop" aria-label="关闭详情" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="inspector-drawer"
        aria-label={titles[section]}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
      >
        <div className="inspector-header">
          <div>
            <span className="eyebrow">UmaAgent</span>
            <h2>{titles[section]}</h2>
          </div>
          <button type="button" className="icon" title="关闭详情" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="inspector-content">{children}</div>
      </aside>
    </>
  );
}
