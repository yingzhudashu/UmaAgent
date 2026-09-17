import type { Health, Session } from "@uma-agent/protocol";
import { ChevronLeft, MessageSquarePlus } from "lucide-react";
import { type ReactNode, useState } from "react";
import umaIcon from "../assets/uma-icon.svg";

export function SessionArea({
  navigation,
  showSessions = true,
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
  navigation?: ReactNode;
  showSessions?: boolean;
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
  const [query, setQuery] = useState("");
  const visible = sessions.filter((session) =>
    session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const online = health?.status === "ok";
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand">
        <div className="brand-mark">
          <img
            src={umaIcon}
            alt="UmaAgent"
            width="34"
            height="34"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        </div>
        <span>UmaAgent</span>
        <button type="button" className="icon mobile-only" onClick={close} title="关闭导航">
          <ChevronLeft />
        </button>
      </div>
      {navigation}
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
      {showSessions && (
        <>
          <label className="session-search">
            <span>搜索会话</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索会话"
              aria-label="搜索会话"
            />
          </label>
          <nav className="session-list" aria-label="会话列表">
            {visible.map((session) => (
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
          {visible.length === 0 && <p className="session-empty">暂无符合条件的会话</p>}
        </>
      )}
      <div className="sidebar-footer">
        <span className={`health-dot ${online ? "online" : "offline"}`} />
        Core {online ? "已连接" : "未连接"}
        {installable && (
          <button type="button" onClick={install}>
            安装应用
          </button>
        )}
      </div>
    </aside>
  );
}
