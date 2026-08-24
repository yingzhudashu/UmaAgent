import type { UmaClient } from "@uma-agent/client";
import type {
  BackgroundTask,
  KnowledgeSource,
  ScheduledTask,
  Session,
  SessionSnapshot,
} from "@uma-agent/protocol";
import { AGENT_SHORTCUT_COMMANDS } from "@uma-agent/protocol";
import { Command, Search, X } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { executeShortcutCommand } from "../commands/shortcutCommands.js";

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
  const [selected, setSelected] = useState<string>(UMA_COMMANDS[0]);
  const filtered = useMemo(
    () => UMA_COMMANDS.filter((command) => command.includes(query.trim().toLowerCase())),
    [query],
  );
  if (!open) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onExecute(selected);
  };
  return (
    <div className="command-overlay" role="presentation">
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="快捷命令">
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
        <form onSubmit={submit} className="command-form">
          <label className="command-search" htmlFor="uma-command-search">
            <Search size={16} aria-hidden="true" />
            <input
              id="uma-command-search"
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
                aria-selected={selected === command}
                className={selected === command ? "selected" : ""}
                key={command}
                onClick={() => setSelected(command)}
                onDoubleClick={() => onExecute(command)}
              >
                <code>{command}</code>
              </button>
            ))}
          </div>
          {output && (
            <pre className="command-output" aria-live="polite">
              {output}
            </pre>
          )}
          <button type="submit" className="primary command-run" disabled={busy || !selected}>
            {busy ? "执行中…" : `执行 ${selected}`}
          </button>
        </form>
      </section>
    </div>
  );
}

export function CommandPaletteHost({
  open,
  client,
  sessionId,
  models,
  sessions,
  snapshot,
  tasks,
  schedules,
  knowledge,
  memoryCount,
  report,
  publicConfig,
  evaluations,
  optimization,
  skills,
  onClose,
}: {
  open: boolean;
  client: UmaClient;
  sessionId: string | undefined;
  models: Array<{ provider: string; id: string }> | undefined;
  sessions: Session[] | undefined;
  snapshot: SessionSnapshot | undefined;
  tasks: BackgroundTask[] | undefined;
  schedules: ScheduledTask[] | undefined;
  knowledge: KnowledgeSource[] | undefined;
  memoryCount: number;
  report: unknown | undefined;
  publicConfig: unknown | undefined;
  evaluations: Array<{ id: string; status: string }> | undefined;
  optimization: Array<{ id: string; status: string; title: string }> | undefined;
  skills: { refetch: () => Promise<unknown> };
  onClose: () => void;
}) {
  const [output, setOutput] = useState<string>();
  const [busy, setBusy] = useState(false);
  const execute = async (command: string) => {
    setBusy(true);
    try {
      setOutput(
        await executeShortcutCommand(command, {
          client,
          sessionId,
          models,
          sessions,
          selectedSnapshot: snapshot,
          tasks,
          schedules,
          knowledge,
          memoryCount,
          report: command === "/config" ? publicConfig : report,
          evaluations,
          optimization,
          refreshSkills: () => skills.refetch(),
          reloadSkills: () => client.refreshSkills(),
        }),
      );
    } catch (error) {
      setOutput(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <CommandPalette
      open={open}
      output={output}
      busy={busy}
      onClose={onClose}
      onExecute={(command) => void execute(command)}
    />
  );
}
