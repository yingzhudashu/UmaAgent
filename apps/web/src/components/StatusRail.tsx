import { Activity, BellRing, Cloud, Settings2, Wifi } from "lucide-react";

export type InspectorSection = "connection" | "run" | "approvals" | "sync" | "settings" | "xianyu";

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
        className={open === "connection" ? "active" : ""}
        title={online ? "Core 连接正常" : "Core 连接异常"}
        aria-label={online ? "Core 连接正常" : "Core 连接异常"}
        aria-expanded={open === "connection"}
        onClick={() => onOpen("connection")}
      >
        <Wifi size={17} />
      </button>
      <button
        type="button"
        className={open === "run" ? "active" : ""}
        title="当前运行"
        aria-label="当前运行"
        aria-expanded={open === "run"}
        onClick={() => onOpen("run")}
      >
        <Activity size={17} />
        {busy && <i className="rail-dot running" />}
      </button>
      <button
        type="button"
        className={`${approvals ? "attention" : ""} ${open === "approvals" ? "active" : ""}`}
        title="待审批"
        aria-label={`待审批${approvals ? `，${approvals} 项` : ""}`}
        aria-expanded={open === "approvals"}
        onClick={() => onOpen("approvals")}
      >
        <BellRing size={17} />
        {approvals > 0 && <b>{approvals}</b>}
      </button>
      <button
        type="button"
        className={open === "sync" ? "active" : ""}
        title={online ? "同步正常" : "离线"}
        aria-label={online ? "同步正常" : "离线"}
        aria-expanded={open === "sync"}
        onClick={() => onOpen("sync")}
      >
        <Cloud size={17} className={online ? "online-icon" : ""} />
      </button>
      <button
        type="button"
        className={open === "settings" ? "active" : ""}
        title="会话设置"
        aria-label="会话设置"
        aria-expanded={open === "settings"}
        onClick={() => onOpen("settings")}
      >
        <Settings2 size={17} />
      </button>
    </aside>
  );
}
