import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { InspectorSection } from "./StatusRail.js";

const titles: Record<InspectorSection, string> = {
  run: "当前运行",
  sync: "同步与连接",
  settings: "会话设置",
  resources: "资源",
  admin: "管理",
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
  if (!section) return null;
  return (
    <aside className="inspector-drawer" aria-label={titles[section]}>
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
  );
}
