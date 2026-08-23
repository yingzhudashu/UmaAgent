import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { InspectorSection } from "./StatusRail.js";

const titles: Record<InspectorSection, string> = {
  connection: "Core 连接",
  run: "当前运行",
  approvals: "待审批",
  sync: "同步与连接",
  settings: "会话设置",
};

export function InspectorDrawer({
  section,
  onClose,
  children,
}: {
  section: InspectorSection | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!section) return;
    drawerRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, section]);
  if (!section) return null;
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
