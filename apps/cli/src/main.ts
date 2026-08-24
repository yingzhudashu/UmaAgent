#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  Box,
  Editor,
  Markdown,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { UmaClient, UmaClientError } from "@uma-agent/client";
import {
  AGENT_SHORTCUT_COMMANDS,
  type AgentEventEnvelope,
  type Approval,
  PROTOCOL_VERSION,
  type Session,
  type SessionSnapshot,
  type TranscriptItem,
} from "@uma-agent/protocol";
import clipboard from "clipboardy";
import { BUILTIN_EVALUATIONS, runBuiltInEvaluations } from "./evaluations.js";
import { createTuiAutocomplete } from "./tui-completion.js";

const args = process.argv.slice(2);
const command = args[0] ?? "chat";
const valueAfter = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const positionals = args.slice(1).filter((arg) => !arg.startsWith("--"));
const server = valueAfter("--server") ?? process.env.UMA_SERVER_URL ?? "http://127.0.0.1:3210";
const token = valueAfter("--token") ?? process.env.UMA_TOKEN;
const client = new UmaClient({ baseUrl: server, ...(token ? { token } : {}) });
const cliStateDir = process.env.UMA_CLI_STATE_DIR?.trim() || join(homedir(), ".uma-agent", "cli");
const cliHistoryPath = join(cliStateDir, "history.txt");

async function loadCliHistory(): Promise<string[]> {
  try {
    return (await readFile(cliHistoryPath, "utf8"))
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(-1_000);
  } catch {
    return [];
  }
}

async function saveCliHistory(value: string): Promise<void> {
  const history = [...(await loadCliHistory()), value].slice(-1_000);
  await mkdir(cliStateDir, { recursive: true });
  await writeFile(cliHistoryPath, `${history.join("\n")}\n`, "utf8");
}

function renderTranscript(items: TranscriptItem[]): string {
  return items
    .map((item) => {
      const label = item.role === "user" ? "You" : item.role === "assistant" ? "Uma" : (item.name ?? "Tool");
      const suffix = item.status === "streaming" ? " [running]" : item.status === "error" ? " [error]" : "";
      const content = item.content.length > 4_000 ? `${item.content.slice(0, 4_000)}\n...` : item.content;
      return `${label}${suffix}\n${content}`;
    })
    .join("\n\n");
}

async function chooseInitialSession(): Promise<Session> {
  const sessions = await client.listSessions();
  const requested = valueAfter("--session");
  if (requested) return client.getSession(requested).then((snapshot) => snapshot.session);
  return sessions[0] ?? client.createSession();
}

async function chat(): Promise<void> {
  let active = await chooseInitialSession();
  let snapshot = await client.getSession(active.id);
  const approvals = new Map<string, Approval>();
  const attachmentIds: string[] = [];
  let historical: TranscriptItem[] = [];
  let scrollOffset = 0;
  const ui = new TuiMainScreen(new ProcessTerminal());
  const header = new Text("", 1, 0);
  const style = (value: string) => value;
  const transcript = new Markdown("", 1, 1, {
    heading: style,
    link: style,
    linkUrl: style,
    code: style,
    codeBlock: style,
    codeBlockBorder: style,
    quote: style,
    quoteBorder: style,
    hr: style,
    listBullet: style,
    bold: style,
    italic: style,
    strikethrough: style,
    underline: style,
  });
  const transcriptScroll = new ScrollView(transcript, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });
  const status = new Text("", 1, 0);
  const inputBox = new Box(1, 0);
  const input = new Editor(ui, {
    borderColor: style,
    selectList: {
      selectedPrefix: style,
      selectedText: style,
      description: style,
      scrollInfo: style,
      noMatch: style,
    },
  });
  for (const item of await loadCliHistory()) input.addToHistory(item);
  input.setAutocompleteProvider(createTuiAutocomplete(process.cwd()));
  inputBox.addChild(new Text("Message", 0, 0));
  inputBox.addChild(input);
  ui.addChild(header);
  ui.addChild(transcriptScroll);
  ui.addChild(new Spacer(1));
  ui.addChild(status);
  ui.addChild(inputBox);
  ui.setFocus(input);

  const render = (notice?: string) => {
    const run = snapshot.recentRuns.at(-1);
    header.setText(
      `UmaAgent  ${active.title}\n${active.model.provider}/${active.model.id}  ${active.workspace}`,
    );
    const items = [
      ...new Map([...historical, ...snapshot.transcript].map((item) => [item.id, item])).values(),
    ].sort((a, b) => a.sequence - b.sequence);
    transcript.setText(renderTranscript(items) || "No messages yet.");
    const plan = run?.plan.length
      ? `  ${run.plan.map((step) => `${step.status === "completed" ? "[x]" : "[ ]"} ${step.title}`).join("  ")}`
      : "";
    const attached = attachmentIds.length ? `  attachments:${attachmentIds.length}` : "";
    status.setText(notice ?? `${run ? `run:${run.status}` : "ready"}${plan}${attached}  /help`);
    ui.requestRender();
  };

  let refreshTimer: NodeJS.Timeout | undefined;
  const refresh = (notice?: string) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void client
        .getSession(active.id)
        .then((next) => {
          snapshot = next;
          active = next.session;
          render(notice);
        })
        .catch((error: unknown) => render(error instanceof Error ? error.message : String(error)));
    }, 60);
  };
  const eventHandler = (event: AgentEventEnvelope) => {
    if (event.type === "session.snapshot") {
      snapshot = event.payload as SessionSnapshot;
      active = snapshot.session;
      render();
      return;
    }
    if (event.type === "approval.requested") {
      const approval = event.payload as Approval;
      approvals.set(approval.id, approval);
      refresh(`Approval: ${approval.toolName}  /approve ${approval.id} yes|no`);
      return;
    }
    if (event.type === "approval.resolved") approvals.delete((event.payload as Approval).id);
    refresh();
  };
  let unsubscribe = client.subscribe(active.id, eventHandler);
  client.connectEvents();

  const switchSession = async (session: Session) => {
    unsubscribe();
    active = session;
    snapshot = await client.getSession(session.id);
    historical = [];
    scrollOffset = 0;
    unsubscribe = client.subscribe(session.id, eventHandler);
    approvals.clear();
    attachmentIds.splice(0);
    render();
  };

  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = async (raw: string) => {
    const value = raw.trim();
    if (value) {
      input.addToHistory(value);
      await saveCliHistory(value);
    }
    input.setText("");
    ui.requestRender();
    if (!value) return;
    if (value === "/exit" || value === "/quit") {
      finish();
      return;
    }
    if (AGENT_SHORTCUT_COMMANDS.includes(value as (typeof AGENT_SHORTCUT_COMMANDS)[number])) {
      render((await client.executeShortcut(active.id, value)).output);
      return;
    }
    if (value === "/new") {
      await switchSession(await client.createSession());
      return;
    }
    if (value === "/sessions") {
      const list = await client.listSessions();
      render(list.map((item) => `${item.id} ${item.title}`).join("  "));
      return;
    }
    if (value.startsWith("/session delete ")) {
      const id = value.slice(16).trim();
      if (id === active.id) throw new Error("Switch sessions before deleting the active session");
      await client.deleteSession(id);
      render(`Deleted session ${id}`);
      return;
    }
    if (value.startsWith("/use ")) {
      await switchSession(await client.getSession(value.slice(5).trim()).then((item) => item.session));
      return;
    }
    if (value.startsWith("/rename ")) {
      active = await client.updateSession(active.id, { title: value.slice(8).trim() });
      refresh();
      return;
    }
    if (value === "/older") {
      const all = [...historical, ...snapshot.transcript].sort((a, b) => a.sequence - b.sequence);
      if (scrollOffset + 14 >= all.length && snapshot.history.hasMoreBefore) {
        const page = await client.getSessionHistory(active.id, all[0]?.sequence, 100);
        historical = [...new Map([...page.items, ...historical].map((item) => [item.id, item])).values()];
      }
      scrollOffset = Math.min(
        scrollOffset + 14,
        Math.max(0, historical.length + snapshot.transcript.length - 1),
      );
      transcriptScroll.scrollBy(-14);
      render();
      return;
    }
    if (value === "/newer") {
      scrollOffset = Math.max(0, scrollOffset - 14);
      transcriptScroll.scrollBy(14);
      render();
      return;
    }
    if (value.startsWith("/model ")) {
      const [provider, ...id] = value.slice(7).trim().split("/");
      if (!provider || !id.length) throw new Error("Use /model <provider/id>");
      active = await client.updateSession(active.id, { model: { provider, id: id.join("/") } });
      refresh();
      return;
    }
    if (value.startsWith("/attach ")) {
      const path = value.slice(8).trim();
      const data = await readFile(path);
      const uploaded = await client.upload(new Blob([data]), basename(path), active.id);
      attachmentIds.push(uploaded.id);
      render(`Attached ${uploaded.name}`);
      return;
    }
    if (value === "/cancel") {
      const run = snapshot.recentRuns.at(-1);
      if (run) await client.cancelRun(run.id);
      return;
    }
    if (value === "/compact") {
      const summary = await client.compactSession(active.id);
      render(`Compacted through message ${summary.throughSequence}`);
      return;
    }
    if (value === "/review" || value.startsWith("/review ")) {
      const target = [...snapshot.transcript].reverse().find((item) => item.role === "assistant");
      if (!target) throw new Error("No assistant answer is available to review");
      await client.reviewMessage(target.id, value.slice(7).trim());
      refresh("Review queued");
      return;
    }
    if (value === "/improve" || value.startsWith("/improve ")) {
      const target = [...snapshot.transcript].reverse().find((item) => item.role === "assistant");
      if (!target) throw new Error("No assistant answer is available to improve");
      await client.improveMessage(target.id, {
        force: value.includes("--force"),
        reset: value.includes("--reset"),
      });
      refresh("Improvement queued");
      return;
    }
    if (value === "/queue status") {
      render(`Queue mode: ${active.queueMode}`);
      return;
    }
    if (value.startsWith("/queue set ")) {
      const mode = value.slice(11).trim();
      if (mode !== "queue" && mode !== "preemptive") throw new Error("Use /queue set queue|preemptive");
      active = await client.updateSession(active.id, { queueMode: mode });
      render(`Queue mode: ${active.queueMode}`);
      return;
    }
    if (value === "/queue abort") {
      const runs = snapshot.recentRuns.filter((run) => run.status === "queued");
      await Promise.all(runs.map((run) => client.cancelRun(run.id)));
      refresh(`Cancelled ${runs.length} queued run(s)`);
      return;
    }
    if (value.startsWith("/btw start ")) {
      const task = await client.createTask(value.slice(11).trim(), active.id);
      render(`Background task ${task.id} started`);
      return;
    }
    if (value === "/btw status" || value === "/btw result") {
      const tasks = await client.listTasks();
      render(tasks.map((task) => `${task.id} ${task.status} ${task.result ?? task.prompt}`).join("  "));
      return;
    }
    if (value === "/btw clear") {
      const tasks = await client.listTasks();
      const terminal = tasks.filter((task) => !["pending", "running"].includes(task.status));
      await Promise.all(terminal.map((task) => client.deleteTask(task.id)));
      render(`Deleted ${terminal.length} terminal background task(s)`);
      return;
    }
    if (value.startsWith("/btw cancel ")) {
      const task = await client.cancelTask(value.slice(12).trim());
      render(`Background task ${task.id}: ${task.status}`);
      return;
    }
    if (value === "/reload-skills") {
      const skills = await client.refreshSkills();
      render(`Reloaded ${skills.length} skill(s)`);
      return;
    }
    if (value === "/reload-config") {
      const result = await client.reloadConfig();
      render(
        `Applied: ${result.applied.join(", ") || "none"}; restart: ${result.restartRequired.join(", ") || "none"}`,
      );
      return;
    }
    if (value === "/stats") {
      const report = await client.diagnosticsReport();
      render(JSON.stringify(report, null, 2));
      return;
    }
    if (value === "/config") {
      render(JSON.stringify(await client.publicConfig(), null, 2));
      return;
    }
    if (value === "/doctor") {
      render(JSON.stringify(await client.health(), null, 2));
      return;
    }
    if (value === "/copy") {
      const latest = [...snapshot.transcript].reverse().find((item) => item.role === "assistant");
      if (!latest) throw new Error("No assistant answer is available to copy");
      await clipboard.write(latest.content);
      render("Copied the latest assistant answer");
      return;
    }
    if (value === "/schedule list") {
      render(JSON.stringify(await client.listSchedules(), null, 2));
      return;
    }
    if (value.startsWith("/schedule show ")) {
      const id = value.slice(15).trim();
      const item = (await client.listSchedules()).find((schedule) => schedule.id === id);
      if (!item) throw new Error("Schedule not found");
      render(JSON.stringify(item, null, 2));
      return;
    }
    if (value.startsWith("/schedule run ")) {
      render(JSON.stringify(await client.runSchedule(value.slice(14).trim()), null, 2));
      return;
    }
    if (value.startsWith("/schedule remove ")) {
      await client.deleteSchedule(value.slice(17).trim());
      render("Schedule removed");
      return;
    }
    if (value.startsWith("/schedule enable ") || value.startsWith("/schedule disable ")) {
      const enabled = value.startsWith("/schedule enable ");
      const id = value.slice(enabled ? 17 : 18).trim();
      render(JSON.stringify(await client.updateSchedule(id, { enabled }), null, 2));
      return;
    }
    if (value.startsWith("/schedule add ")) {
      const created = await client.createSchedule(JSON.parse(value.slice(14).trim()));
      render(JSON.stringify(created, null, 2));
      return;
    }
    if (value.startsWith("/schedule update ")) {
      const remainder = value.slice(17).trim();
      const separator = remainder.indexOf(" ");
      if (separator < 1) throw new Error("Use /schedule update <id> <json-patch>");
      const updated = await client.updateSchedule(
        remainder.slice(0, separator),
        JSON.parse(remainder.slice(separator + 1)),
      );
      render(JSON.stringify(updated, null, 2));
      return;
    }
    if (value === "/kb list") {
      const sources = await client.listKnowledge();
      render(
        sources.map((item) => `${item.id} ${item.status} ${item.name}`).join("  ") || "No knowledge sources",
      );
      return;
    }
    if (value.startsWith("/kb search ")) {
      const hits = await client.searchKnowledge(value.slice(11).trim());
      render(
        hits.map((item) => `${item.sourceName}/${item.filePath}\n${item.content}`).join("\n\n") ||
          "No results",
      );
      return;
    }
    if (value.startsWith("/kb unmount ")) {
      await client.deleteKnowledge(value.slice(12).trim());
      render("Knowledge source removed");
      return;
    }
    if (value.startsWith("/kb reload ")) {
      const source = await client.reindexKnowledge(value.slice(11).trim());
      render(`Knowledge source ${source.name}: ${source.status}`);
      return;
    }
    if (value.startsWith("/kb mount ")) {
      const [path, ...name] = value.slice(10).trim().split(/\s+/);
      if (!path) throw new Error("Use /kb mount <server-path> [name]");
      const source = await client.indexKnowledge(name.join(" ") || basename(path), path);
      render(`Knowledge source ${source.name}: ${source.status}`);
      return;
    }
    if (value === "/test list") {
      render(BUILTIN_EVALUATIONS.map((item) => `${item.category} ${item.name}`).join("\n"));
      return;
    }
    if (value === "/test status") {
      const reports = await client.listEvaluationReports(1);
      render(reports[0] ? JSON.stringify(reports[0], null, 2) : "No evaluation reports");
      return;
    }
    if (value === "/test run" || value.startsWith("/test run ")) {
      const [, , requestedMode, category, pattern] = value.split(/\s+/);
      const mode = requestedMode === "real" ? "real" : "faux";
      const report = await runBuiltInEvaluations(
        client,
        mode,
        requestedMode === "real" || requestedMode === "faux" ? category : requestedMode,
        requestedMode === "real" || requestedMode === "faux" ? pattern : category,
      );
      render(JSON.stringify(report, null, 2));
      return;
    }
    if (value === "/self-opt status" || value === "/self-opt proposals") {
      render(JSON.stringify(await client.listOptimizationProposals(), null, 2));
      return;
    }
    if (value.startsWith("/self-opt show ")) {
      const id = value.slice(15).trim();
      const proposal = (await client.listOptimizationProposals()).find((item) => item.id === id);
      if (!proposal) throw new Error("Optimization proposal not found");
      render(JSON.stringify(proposal, null, 2));
      return;
    }
    if (value === "/self-opt analyze") {
      render(JSON.stringify(await client.generateOptimizationProposals(), null, 2));
      return;
    }
    if (value.startsWith("/self-opt accept ") || value.startsWith("/self-opt reject ")) {
      const accept = value.startsWith("/self-opt accept ");
      const id = value.slice(accept ? 17 : 17).trim();
      render(
        JSON.stringify(
          await client.decideOptimizationProposal(id, accept ? "accepted" : "rejected"),
          null,
          2,
        ),
      );
      return;
    }
    if (value === "/self-opt report") {
      render(JSON.stringify(await client.diagnosticsReport(), null, 2));
      return;
    }
    if (value.startsWith("/approve ")) {
      const [, id, answer] = value.split(/\s+/);
      if (!id || !approvals.has(id)) throw new Error("Approval is not pending");
      await client.resolveApproval(id, answer === "yes" || answer === "y");
      approvals.delete(id);
      return;
    }
    if (value === "/actions") {
      const run = snapshot.recentRuns.at(-1);
      if (!run) throw new Error("No run is available");
      const actions = await client.listRunActions(run.id);
      render(actions.map((action) => `${action.id} ${action.toolName} ${action.status}`).join("  "));
      return;
    }
    if (value.startsWith("/decide ")) {
      const [, actionId, decision] = value.split(/\s+/);
      const run = snapshot.recentRuns.at(-1);
      if (!run || !actionId || !new Set(["approve", "reject", "acknowledge"]).has(decision ?? ""))
        throw new Error("Use /decide <action-id> approve|reject|acknowledge");
      await client.decideRunAction(run.id, actionId, decision as "approve" | "reject" | "acknowledge");
      refresh();
      return;
    }
    if (value === "/resume") {
      const run = snapshot.recentRuns.at(-1);
      if (!run) throw new Error("No run is available");
      await client.resumeRun(run.id);
      refresh();
      return;
    }
    if (value.startsWith("!")) {
      const command = value.slice(1).trim();
      if (!command) throw new Error("Shell command is required");
      await client.sendCommand(active.id, command);
      refresh("Command awaiting approval");
      return;
    }
    let outgoing = value;
    for (const match of value.matchAll(/@file:(?:"([^"]+)"|(\S+))/g)) {
      const path = match[1] ?? match[2];
      if (!path) continue;
      const data = await readFile(path);
      const uploaded = await client.upload(new Blob([data]), basename(path), active.id);
      attachmentIds.push(uploaded.id);
      outgoing = outgoing.replace(match[0], "").trim();
    }
    await client.sendMessage(active.id, outgoing || "Please inspect the attached file.", {
      mode: "agent",
      ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}),
    });
    attachmentIds.splice(0);
    scrollOffset = 0;
    refresh();
  };
  input.onSubmit = (value) =>
    void handle(value).catch((error: unknown) =>
      render(error instanceof Error ? error.message : String(error)),
    );
  const removeEscapeListener = ui.addInputListener((data) => {
    if (data !== "\u001b") return undefined;
    void client.cancel(active.id).catch(() => {});
    return { consume: true };
  });
  const interrupt = () => finish();
  process.once("SIGINT", interrupt);
  render();
  ui.start();
  await done;
  if (refreshTimer) clearTimeout(refreshTimer);
  process.removeListener("SIGINT", interrupt);
  removeEscapeListener();
  unsubscribe();
  client.close();
  ui.stop();
}

async function sessionCommand(): Promise<void> {
  const action = positionals[0] ?? "list";
  if (action === "list") {
    for (const session of await client.listSessions())
      console.log(
        `${session.id}\t${session.title}\t${session.model.provider}/${session.model.id}\t${session.workspace ?? "-"}`,
      );
  } else if (action === "create") {
    console.log((await client.createSession({ ...(positionals[1] ? { title: positionals[1] } : {}) })).id);
  } else if (action === "delete" && positionals[1]) await client.deleteSession(positionals[1]);
  else if (action === "rename" && positionals[1] && positionals[2])
    await client.updateSession(positionals[1], { title: positionals.slice(2).join(" ") });
  else throw new Error("uma session list|create [title]|delete <id>|rename <id> <title>");
}

async function taskCommand(): Promise<void> {
  const action = positionals[0] ?? "list";
  if (action === "start") {
    const prompt = positionals.slice(1).join(" ").trim();
    if (!prompt) throw new Error("uma task start <prompt>");
    console.log(JSON.stringify(await client.createTask(prompt), null, 2));
  } else if (action === "list") {
    for (const task of await client.listTasks()) console.log(`${task.id}\t${task.status}\t${task.prompt}`);
  } else if (action === "show" && positionals[1])
    console.log(JSON.stringify(await client.getTask(positionals[1]), null, 2));
  else if (action === "cancel" && positionals[1])
    console.log(JSON.stringify(await client.cancelTask(positionals[1]), null, 2));
  else if (action === "delete" && positionals[1]) await client.deleteTask(positionals[1]);
  else throw new Error("uma task start <prompt>|list|show <id>|cancel <id>|delete <id>");
}

async function scheduleCommand(): Promise<void> {
  const action = positionals[0] ?? "list";
  if (action === "list") {
    for (const item of await client.listSchedules())
      console.log(
        `${item.id}\t${item.enabled ? "enabled" : "disabled"}\t${item.schedule.kind}\t${item.nextRunAt ?? "-"}\t${item.name}`,
      );
    return;
  }
  const id = positionals[1];
  if (action === "run" && id) {
    console.log(JSON.stringify(await client.runSchedule(id), null, 2));
    return;
  }
  if (action === "history" && id) {
    console.log(JSON.stringify(await client.listScheduleRuns(id), null, 2));
    return;
  }
  if (action === "delete" && id) {
    await client.deleteSchedule(id);
    return;
  }
  if ((action === "enable" || action === "disable") && id) {
    console.log(JSON.stringify(await client.updateSchedule(id, { enabled: action === "enable" }), null, 2));
    return;
  }
  if (action === "create") {
    const name = valueAfter("--name")?.trim();
    const prompt = valueAfter("--prompt")?.trim();
    if (!name || !prompt) throw new Error("schedule create requires --name= and --prompt=");
    const once = valueAfter("--once");
    const interval = valueAfter("--interval");
    const cron = valueAfter("--cron");
    const schedule = once
      ? { kind: "once" as const, at: Date.parse(once) }
      : interval
        ? { kind: "interval" as const, everyMs: Number(interval) }
        : cron
          ? { kind: "cron" as const, expression: cron, timezone: valueAfter("--timezone") ?? "UTC" }
          : undefined;
    if (!schedule || (schedule.kind === "once" && !Number.isSafeInteger(schedule.at)))
      throw new Error("schedule create requires --once=ISO, --interval=MS, or --cron=EXPR");
    console.log(JSON.stringify(await client.createSchedule({ name, prompt, schedule }), null, 2));
    return;
  }
  throw new Error("uma schedule list|create|run|history|enable|disable|delete");
}

async function memoryCommand(): Promise<void> {
  const action = positionals[0] ?? "list";
  if (action === "list" || action === "review") {
    const status = action === "review" ? "candidate" : undefined;
    for (const fact of await client.listMemoryFacts(status))
      console.log(`${fact.id}\t${fact.status}\t${fact.confidence.toFixed(2)}\t${fact.key}=${fact.value}`);
    return;
  }
  const id = positionals[1];
  if (!id) throw new Error("Memory fact id is required");
  const status = action === "accept" ? "active" : action === "reject" ? "rejected" : undefined;
  if (!status) throw new Error("uma memory list|review|accept <id>|reject <id>");
  console.log(JSON.stringify(await client.reviewMemoryFact(id, status), null, 2));
}

async function auditCommand(): Promise<void> {
  if (positionals[0] !== "run" || !positionals[1]) throw new Error("uma audit run <run-id>");
  console.log(JSON.stringify(await client.listAudit(positionals[1]), null, 2));
}

async function runCommand(): Promise<void> {
  const action = positionals[0];
  if (action === "resume" && positionals[1]) {
    console.log(JSON.stringify(await client.resumeRun(positionals[1]), null, 2));
    return;
  }
  if (action === "actions" && positionals[1]) {
    console.log(JSON.stringify(await client.listRunActions(positionals[1]), null, 2));
    return;
  }
  if (action === "checkpoints" && positionals[1]) {
    console.log(JSON.stringify(await client.listRunCheckpoints(positionals[1]), null, 2));
    return;
  }
  if (action === "decide" && positionals[1] && positionals[2] && positionals[3]) {
    const decision = positionals[3];
    if (!new Set(["approve", "reject", "acknowledge"]).has(decision))
      throw new Error("Decision must be approve, reject, or acknowledge");
    console.log(
      JSON.stringify(
        await client.decideRunAction(
          positionals[1],
          positionals[2],
          decision as "approve" | "reject" | "acknowledge",
        ),
        null,
        2,
      ),
    );
    return;
  }
  const prompt = positionals.join(" ").trim();
  if (!prompt) throw new Error("uma run --json <prompt>");
  const session = await chooseInitialSession();
  const initial = await client.getSession(session.id);
  console.log(JSON.stringify({ type: "snapshot", payload: initial }));
  const buffered: AgentEventEnvelope[] = [];
  const emitted = new Set<number>();
  let acceptedRunId: string | undefined;
  client.connectEvents();
  const unsubscribe = client.subscribeSessions(
    [{ id: session.id, lastSequence: initial.snapshotSequence }],
    (event) => {
      if (!acceptedRunId) buffered.push(event);
      else if (event.runId === acceptedRunId && !emitted.has(event.sequence)) {
        emitted.add(event.sequence);
        console.log(JSON.stringify({ type: "durable.event", payload: event }));
      }
    },
  );
  const accepted = await client.sendMessage(session.id, prompt, { mode: "agent" });
  acceptedRunId = accepted.runId;
  console.log(
    JSON.stringify({
      type: "run.accepted",
      sessionId: session.id,
      runId: accepted.runId,
      status: accepted.status,
    }),
  );
  for (const event of buffered)
    if (event.runId === acceptedRunId) {
      emitted.add(event.sequence);
      console.log(JSON.stringify({ type: "durable.event", payload: event }));
    }
  buffered.length = 0;
  const terminal = await client.waitForRun(accepted.runId);
  let catchupAfter = initial.snapshotSequence;
  while (true) {
    const page = await client.getSessionEvents(session.id, catchupAfter, 1000);
    for (const event of page.events) {
      if (event.runId === acceptedRunId && !emitted.has(event.sequence)) {
        emitted.add(event.sequence);
        console.log(JSON.stringify({ type: "durable.event", payload: event }));
      }
    }
    catchupAfter = page.nextSequence;
    if (!page.hasMore) break;
  }
  console.log(
    JSON.stringify({
      type: "run.terminal",
      sessionId: session.id,
      runId: terminal.id,
      status: terminal.status,
      payload: terminal,
    }),
  );
  unsubscribe();
}

async function syncCommand(): Promise<void> {
  const sessionId = positionals[0];
  if (!sessionId) throw new Error("uma sync <session-id>");
  const snapshot = await client.getSession(sessionId);
  console.log(JSON.stringify({ type: "snapshot", payload: snapshot }));
  let after = snapshot.snapshotSequence;
  while (true) {
    const page = await client.getSessionEvents(sessionId, after, 1000);
    for (const event of page.events) console.log(JSON.stringify({ type: "durable.event", payload: event }));
    after = page.nextSequence;
    if (!page.hasMore) break;
  }
}

async function skillCommand(): Promise<void> {
  const skills = positionals[0] === "refresh" ? await client.refreshSkills() : await client.listSkills();
  for (const skill of skills)
    console.log(`${skill.enabled ? "ok" : "invalid"}\t${skill.name}\t${skill.description}`);
}

async function mcpCommand(): Promise<void> {
  for (const item of await client.mcpStatus())
    console.log(
      `${item.connected ? "online" : "offline"}\t${item.name}\t${item.toolCount}${item.error ? `\t${item.error}` : ""}`,
    );
}

async function knowledgeCommand(): Promise<void> {
  const action = positionals[0] ?? "list";
  if ((action === "add" || action === "mount") && positionals[1] && positionals[2])
    await client.indexKnowledge(positionals[1], positionals[2]);
  else if (action === "search" && positionals[1]) {
    console.log(JSON.stringify(await client.searchKnowledge(positionals.slice(1).join(" ")), null, 2));
    return;
  } else if ((action === "delete" || action === "unmount") && positionals[1]) {
    await client.deleteKnowledge(positionals[1]);
    return;
  } else if ((action === "reload" || action === "reindex") && positionals[1]) {
    console.log(JSON.stringify(await client.reindexKnowledge(positionals[1]), null, 2));
    return;
  } else if (action !== "list")
    throw new Error("uma knowledge list|mount <name> <path>|search <query>|unmount <id>|reload <id>");
  for (const item of await client.listKnowledge())
    console.log(`${item.id}\t${item.name}\t${item.documentCount}\t${item.path}`);
}

async function evalCommand(): Promise<void> {
  const action = positionals[0] ?? "status";
  if (action === "list") {
    for (const item of BUILTIN_EVALUATIONS) console.log(`${item.category}\t${item.name}`);
    return;
  }
  if (action === "status" || action === "history") {
    console.log(
      JSON.stringify(await client.listEvaluationReports(Number(valueAfter("--limit") ?? 20)), null, 2),
    );
    return;
  }
  if (action === "show" && positionals[1]) {
    console.log(JSON.stringify(await client.getEvaluationReport(positionals[1]), null, 2));
    return;
  }
  if (action === "run") {
    const mode = positionals[1] === "real" ? "real" : "faux";
    const offset = positionals[1] === "real" || positionals[1] === "faux" ? 2 : 1;
    console.log(
      JSON.stringify(
        await runBuiltInEvaluations(client, mode, positionals[offset], positionals[offset + 1]),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error("uma eval list|run [faux|real] [category] [pattern]|status|show <id>");
}

async function doctorCommand(): Promise<void> {
  const health = await client.health();
  let authenticated = false;
  let models: Array<{ provider: string; id: string }> = [];
  try {
    models = await client.listModels();
    authenticated = true;
  } catch (error) {
    if (!(error instanceof UmaClientError) || error.status !== 401) throw error;
  }
  const protocolCompatible = health.protocolVersion === PROTOCOL_VERSION;
  const result = {
    ok: health.status === "ok" && authenticated && protocolCompatible,
    server,
    status: health.status,
    version: health.version,
    protocolVersion: health.protocolVersion,
    protocolCompatible,
    authenticated,
    activeRuns: health.activeRuns,
    models,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function channelStatusCommand(): Promise<void> {
  const channelUrl = valueAfter("--channel-url") ?? process.env.UMA_CHANNEL_URL;
  if (!channelUrl) throw new Error("Set --channel-url=<url> or UMA_CHANNEL_URL to query an Adapter");
  const response = await fetch(`${channelUrl.replace(/\/$/, "")}/health`);
  if (!response.ok) throw new Error(`Channel health request failed: HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function main(): Promise<void> {
  if (command === "chat") return chat();
  if (command === "run") await runCommand();
  else if (command === "session" || command === "sessions") await sessionCommand();
  else if (command === "skill" || command === "skills") await skillCommand();
  else if (command === "mcp") await mcpCommand();
  else if (command === "knowledge") await knowledgeCommand();
  else if (command === "doctor") await doctorCommand();
  else if (command === "status") await doctorCommand();
  else if (command === "task") await taskCommand();
  else if (command === "schedule") await scheduleCommand();
  else if (command === "memory") await memoryCommand();
  else if (command === "audit") await auditCommand();
  else if (command === "eval" || command === "test") await evalCommand();
  else if (command === "sync") await syncCommand();
  else if (command === "channel" && positionals[0] === "status") await channelStatusCommand();
  else
    console.log(
      "UmaAgent CLI\n\numa chat [--session=ID] [--server=URL] [--token=TOKEN]\numa run --json <prompt>\numa run resume|checkpoints|actions|decide ...\numa sync <session-id>\numa session list|create|delete|rename\numa task start|list|show|cancel|delete\numa schedule list|create|run|history|enable|disable|delete\numa memory list|review|accept|reject\numa eval list|run|status|show\numa audit run <run-id>\numa skill list|refresh\numa mcp status\numa knowledge list|mount|search|unmount|reload\numa channel status --channel-url=<url>\numa doctor",
    );
  client.close();
}

await main().catch((error: unknown) => {
  client.close();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
