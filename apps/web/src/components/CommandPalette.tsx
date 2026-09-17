import type { UmaClient } from "@uma-agent/client";
import { AGENT_SHORTCUT_CATALOG, AGENT_SHORTCUT_COMMANDS } from "@uma-agent/protocol";
import { Command, Search, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

export const UMA_COMMANDS = AGENT_SHORTCUT_COMMANDS;

export function CommandPalette({
  open,
  output,
  busy,
  onClose,
  onExecute,
}: {
  open: boolean;
  output?: string | undefined;
  busy: boolean;
  onClose: () => void;
  onExecute: (command: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(UMA_COMMANDS[0] ?? "");
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    search.current?.focus();
    return () => {
      element?.close();
      before?.focus();
    };
  }, [open]);
  const filtered = useMemo(
    () =>
      AGENT_SHORTCUT_CATALOG.filter((item) =>
        `${item.command} ${item.title} ${item.description}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ).map((item) => item.command),
    [query],
  );
  const active = filtered.includes(selected) ? selected : filtered[0];
  if (!open) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && active) onExecute(active);
  };
  return (
    <dialog
      ref={dialog}
      className="command-overlay"
      aria-label="快捷命令"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <section className="command-palette">
        <header className="command-palette-header">
          <div>
            <span className="eyebrow">UmaAgent</span>
            <h2>
              <Command size={17} /> 快捷命令
            </h2>
          </div>
          <button type="button" className="icon" title="关闭快捷命令" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <form
          onSubmit={submit}
          className="command-form"
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              !filtered.length ||
              !["ArrowDown", "ArrowUp"].includes(event.key)
            )
              return;
            event.preventDefault();
            const index = active ? filtered.indexOf(active) : 0;
            const next =
              filtered[(index + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length];
            if (next) setSelected(next);
          }}
        >
          <label className="command-search" htmlFor="uma-command-search">
            <Search size={16} aria-hidden="true" />
            <input
              id="uma-command-search"
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索命令"
            />
          </label>
          <div className="command-list" role="listbox" aria-label="可用命令">
            {filtered.map((command) => (
              <button
                type="button"
                role="option"
                aria-selected={active === command}
                className={active === command ? "selected" : ""}
                disabled={busy}
                key={command}
                onClick={() => setSelected(command)}
                onDoubleClick={() => {
                  if (!busy) onExecute(command);
                }}
              >
                <code>{command}</code>
                <span>{AGENT_SHORTCUT_CATALOG.find((item) => item.command === command)?.title}</span>
                <small>
                  {AGENT_SHORTCUT_CATALOG.find((item) => item.command === command)?.description}
                  {AGENT_SHORTCUT_CATALOG.find((item) => item.command === command)?.admin
                    ? " · 仅管理员"
                    : ""}
                </small>
              </button>
            ))}
          </div>
          {output && (
            <pre className="command-output" aria-live="polite">
              {output}
            </pre>
          )}
          {filtered.length === 0 && <p>没有匹配的命令</p>}
          <button type="submit" className="primary command-run" disabled={busy || !active}>
            {busy ? "执行中…" : active ? `执行 ${active}` : "执行命令"}
          </button>
        </form>
      </section>
    </dialog>
  );
}

export function CommandPaletteHost({
  open,
  onOpen,
  client,
  sessionId,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  client: UmaClient;
  sessionId: string | undefined;
  onClose: () => void;
}) {
  const [output, setOutput] = useState<string>();
  const [busy, setBusy] = useState(false);
  const executing = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" || event.isComposing) return;
      // 嵌入宿主页时只接管当前 UmaAgent 内的键盘，避免覆盖宿主快捷键。
      const shell = host.current?.closest("[data-design-shell]");
      if (!shell?.contains(event.target as Node) || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      onOpen();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onOpen]);
  const execute = async (command: string) => {
    // 同一回执前阻止双击；业务查询和权限判定统一交给 Core。
    if (executing.current) return;
    executing.current = true;
    setBusy(true);
    try {
      if (!sessionId) throw new Error("请先创建或选择会话");
      setOutput((await client.executeShortcut(sessionId, command)).output);
    } catch (error) {
      setOutput(error instanceof Error ? error.message : String(error));
    } finally {
      executing.current = false;
      setBusy(false);
    }
  };
  return (
    <div ref={host} style={{ display: "contents" }}>
      <CommandPalette
        open={open}
        output={output}
        busy={busy}
        onClose={onClose}
        onExecute={(command) => void execute(command)}
      />
    </div>
  );
}
