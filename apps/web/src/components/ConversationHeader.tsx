import type { UmaClient } from "@uma-agent/client";
import type { Session } from "@uma-agent/protocol";
import { Menu } from "lucide-react";

export function ConversationHeader({
  session,
  models,
  disabled,
  openNavigation,
  openCommands,
  update,
  rename,
  remove,
  refresh,
  compact,
}: {
  session: Session | undefined;
  models: Awaited<ReturnType<UmaClient["listModels"]>>;
  disabled: boolean;
  openNavigation: () => void;
  openCommands: () => void;
  update: (patch: Parameters<UmaClient["updateSession"]>[1]) => void;
  rename: () => void;
  remove: () => void;
  refresh: () => void;
  compact: () => void;
}) {
  return (
    <header>
      <button type="button" className="icon mobile-only" onClick={openNavigation} title="打开导航">
        <Menu />
      </button>
      <div>
        <h1>{session?.title ?? "选择会话"}</h1>
        <span className="header-subtitle">{session?.workspace}</span>
      </div>
      <div className="header-actions">
        {session && (
          <select
            className="model-select"
            value={`${session.model.provider}/${session.model.id}`}
            disabled={disabled}
            onChange={(event) => {
              const [provider, ...id] = event.target.value.split("/");
              if (provider && id.length) update({ model: { provider, id: id.join("/") } });
            }}
            title="模型"
          >
            {models.map((model) => (
              <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                {model.provider}/{model.id}
              </option>
            ))}
          </select>
        )}
        <ActionMenu label="会话更多操作">
          <button type="button" onClick={openCommands}>
            快捷命令
          </button>
          <button type="button" onClick={rename} disabled={disabled}>
            重命名会话
          </button>
          <button type="button" onClick={compact} disabled={disabled}>
            压缩上下文
          </button>
          <button type="button" onClick={refresh}>
            刷新会话
          </button>
          <button type="button" onClick={remove} disabled={disabled}>
            删除会话
          </button>
        </ActionMenu>
      </div>
    </header>
  );
}

import { ActionMenu } from "./ActionMenu.js";
