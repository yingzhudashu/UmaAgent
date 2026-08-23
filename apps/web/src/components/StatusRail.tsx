import { Activity, BellRing, Cloud, FolderKanban, PanelRight, Settings2 } from "lucide-react";

export type InspectorSection = "run" | "sync" | "settings" | "resources" | "admin";

export function StatusRail({
  online,
  busy,
  approvals,
  open,
  onOpen,
}: {
  online: boolean;
  busy: boolean;
  approvals: number;
  open: InspectorSection | undefined;
  onOpen: (section: InspectorSection) => void;
}) {
  return (
    <aside className="status-rail" aria-label="工作台状态">
      <button
        type="button"
        className={open === "run" ? "active" : ""}
        title="当前运行"
        onClick={() => onOpen("run")}
      >
        <Activity size={17} />
        {busy && <i className="rail-dot running" />}
      </button>
      <button
        type="button"
        className={approvals ? "attention" : ""}
        title="待审批"
        onClick={() => onOpen("run")}
      >
        <BellRing size={17} />
        {approvals > 0 && <b>{approvals}</b>}
      </button>
      <button
        type="button"
        className={open === "sync" ? "active" : ""}
        title={online ? "同步正常" : "离线"}
        onClick={() => onOpen("sync")}
      >
        <Cloud size={17} className={online ? "online-icon" : ""} />
      </button>
      <button
        type="button"
        className={open === "resources" ? "active" : ""}
        title="资源"
        onClick={() => onOpen("resources")}
      >
        <FolderKanban size={17} />
      </button>
      <button
        type="button"
        className={open === "settings" ? "active" : ""}
        title="会话设置"
        onClick={() => onOpen("settings")}
      >
        <Settings2 size={17} />
      </button>
      <button type="button" className="rail-panel" title="打开详情" onClick={() => onOpen(open ?? "run")}>
        <PanelRight size={17} />
      </button>
    </aside>
  );
}
