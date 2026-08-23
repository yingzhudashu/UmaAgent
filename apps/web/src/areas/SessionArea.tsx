import type { Health, Session } from "@uma-agent/protocol";
import { Bot, ChevronLeft, MessageSquarePlus } from "lucide-react";

export function SessionArea({
  sessions,
  selected,
  open,
  disabled,
  health,
  installable,
  create,
  select,
  close,
  install,
  creating,
  createError,
  retryCreate,
}: {
  sessions: Session[];
  selected: string | undefined;
  open: boolean;
  disabled: boolean;
  creating: boolean;
  createError?: string;
  health: Health | undefined;
  installable: boolean;
  create: () => void;
  retryCreate: () => void;
  select: (id: string) => void;
  close: () => void;
  install: () => void;
}) {
  const online = health?.status === "ok";
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand">
        <div className="brand-mark">
          <Bot size={20} />
        </div>
        <span>UmaAgent</span>
        <button type="button" className="icon mobile-only" onClick={close} title="关闭导航">
          <ChevronLeft />
        </button>
      </div>
      <button type="button" className="new-session" disabled={disabled || creating} onClick={create}>
        <MessageSquarePlus size={17} />
        {creating ? "创建中…" : "新会话"}
      </button>
      {createError && (
        <div className="sidebar-error" role="alert">
          <span>{createError}</span>
          <button type="button" className="text-action" onClick={retryCreate} disabled={creating}>
            重试
          </button>
        </div>
      )}
      <nav>
        {sessions.map((session) => (
          <button
            type="button"
            key={session.id}
            className={selected === session.id ? "active" : ""}
            onClick={() => select(session.id)}
          >
            <span>{session.title}</span>
            <small>{session.model.id}</small>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span className={`health-dot ${online ? "online" : "offline"}`} />
        Core {online ? "online" : "offline"}
        {installable && (
          <button type="button" onClick={install}>
            安装应用
          </button>
        )}
      </div>
    </aside>
  );
}
