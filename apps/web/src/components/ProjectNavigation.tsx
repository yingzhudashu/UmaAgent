import {
  Activity,
  BellRing,
  Brain,
  CalendarClock,
  ChartNoAxesCombined,
  FolderOpen,
  ListTodo,
  MessageSquare,
  Settings2,
  Settings2 as StatusSettings,
  Store,
  Wifi,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export const destinations = {
  sessions: {
    label: "会话",
    icon: MessageSquare,
    screen: "UM-03",
    description: "继续对话，或新建一个工作会话。",
  },
  tasks: { label: "后台任务", icon: ListTodo, screen: "UM-13", description: "查看后台进度，打开运行详情。" },
  schedules: {
    label: "调度",
    icon: CalendarClock,
    screen: "UM-14",
    description: "安排任务执行时间，查看运行记录。",
  },
  resources: {
    label: "资源",
    icon: FolderOpen,
    screen: "UM-17",
    description: "管理知识源、检索资料与扩展能力。",
  },
  memory: { label: "记忆", icon: Brain, screen: "UM-20", description: "确认、拒绝与查看记忆事实。" },
  admin: { label: "质量", icon: ChartNoAxesCombined, screen: "UM-21", description: "评估、诊断与优化建议。" },
  session: {
    label: "设置",
    icon: Settings2,
    screen: "UM-22",
    description: "外观、账号 Profile 与应用设置。",
  },
  xianyu: { label: "咸鱼工作台", icon: Store, screen: "UM-24", description: "渠道状态、会话与商品管理。" },
} as const;
export type Destination = keyof typeof destinations;
export function ProjectNavigation({
  current,
  admin,
  navigate,
  status,
}: {
  current: Destination;
  admin: boolean;
  navigate: (value: Destination) => void;
  status?: {
    online: boolean;
    busy: boolean;
    approvals: number;
    open: string | undefined;
    onOpen: (section: "connection" | "run" | "approvals" | "sync" | "settings") => void;
  };
}) {
  const navRef = useRef<HTMLElement>(null);
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => {
    setHost(navRef.current?.closest("[data-design-shell]") ?? null);
  }, []);
  const keys = (Object.keys(destinations) as Destination[]).filter(
    (key) => admin || !["admin", "xianyu"].includes(key),
  );
  const mobileOrder = ["sessions", "tasks", "schedules", "resources", "session"] as Destination[];
  const render = (key: Destination) => {
    const item = destinations[key];
    const Icon = item.icon;
    return (
      <button
        type="button"
        key={key}
        title={item.label}
        aria-current={key === current ? "page" : undefined}
        onClick={() => navigate(key)}
      >
        <Icon size={20} />
        <span>{item.label}</span>
      </button>
    );
  };
  const statusButton = (
    id: "connection" | "run" | "approvals" | "sync" | "settings",
    label: string,
    Icon: typeof Wifi,
    badge?: number,
  ) => (
    <button
      type="button"
      className={status?.open === id ? "active" : ""}
      title={label}
      aria-label={label}
      onClick={() => status?.onOpen(id)}
    >
      <Icon size={18} />
      <span>{label}</span>
      {badge ? <b>{badge}</b> : null}
    </button>
  );
  return (
    <>
      <nav ref={navRef} className="project-navigation" aria-label="主导航">
        <div className="nav-group-label">工作区</div>
        {keys
          .filter((key) => key === "sessions" || key === "tasks" || key === "resources" || key === "session")
          .map(render)}
        <details className="nav-more">
          <summary>更多工具</summary>
          {keys.filter((key) => !["sessions", "tasks", "resources", "session"].includes(key)).map(render)}
        </details>
        {status && (
          <div className="nav-status-group">
            <div className="nav-group-label">工作台状态</div>
            {statusButton("connection", status.online ? "连接与同步正常" : "连接或同步异常", Wifi)}
            {statusButton("run", status.busy ? "运行中" : "运行记录", Activity)}
            {status.approvals > 0 &&
              statusButton(
                "approvals",
                status.approvals ? `待审批 · ${status.approvals}` : "审批",
                BellRing,
                status.approvals,
              )}

            {statusButton("settings", "会话设置", StatusSettings)}
          </div>
        )}
      </nav>
      {host &&
        createPortal(
          <nav className="project-navigation-mobile" aria-label="移动主导航">
            {mobileOrder.filter((key) => keys.includes(key)).map(render)}
          </nav>,
          host,
        )}
    </>
  );
}
