#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Box, Input, ProcessTerminal, Spacer, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { UmaClient, UmaClientError } from "@uma-agent/client";
import {
  type AgentEventEnvelope,
  type Approval,
  PROTOCOL_VERSION,
  type Session,
  type SessionSnapshot,
  type TranscriptItem,
} from "@uma-agent/protocol";

const args = process.argv.slice(2);
const command = args[0] ?? "chat";
const valueAfter = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const positionals = args.slice(1).filter((arg) => !arg.startsWith("--"));
const server = valueAfter("--server") ?? process.env.UMA_SERVER_URL ?? "http://127.0.0.1:3210";
const token = valueAfter("--token") ?? process.env.UMA_TOKEN;
const client = new UmaClient({ baseUrl: server, ...(token ? { token } : {}) });

function renderTranscript(items: TranscriptItem[], offset = 0): string {
  const end = Math.max(0, items.length - offset);
  return items
    .slice(Math.max(0, end - 14), end)
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
  const transcript = new Text("", 1, 1);
  const status = new Text("", 1, 0);
  const inputBox = new Box(1, 0);
  const input = new Input();
  inputBox.addChild(new Text("Message", 0, 0));
  inputBox.addChild(input);
  ui.addChild(header);
  ui.addChild(transcript);
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
    transcript.setText(renderTranscript(items, scrollOffset) || "No messages yet.");
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
    input.setValue("");
    ui.requestRender();
    if (!value) return;
    if (value === "/exit" || value === "/quit") {
      finish();
      return;
    }
    if (value === "/help") {
      render(
        "/new  /sessions  /use <id>  /older  /newer  /rename <title>  /model <provider/id>  /attach <path>  /approve <id> yes|no  /actions  /decide <action> approve|reject|acknowledge  /resume  /cancel  /exit",
      );
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
      render();
      return;
    }
    if (value === "/newer") {
      scrollOffset = Math.max(0, scrollOffset - 14);
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
    await client.sendMessage(
      active.id,
      value,
      attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {},
    );
    attachmentIds.splice(0);
    scrollOffset = 0;
    refresh();
  };
  input.onSubmit = (value) =>
    void handle(value).catch((error: unknown) =>
      render(error instanceof Error ? error.message : String(error)),
    );
  input.onEscape = () => void client.cancel(active.id).catch(() => {});
  const interrupt = () => finish();
  process.once("SIGINT", interrupt);
  render();
  ui.start();
  await done;
  if (refreshTimer) clearTimeout(refreshTimer);
  process.removeListener("SIGINT", interrupt);
  unsubscribe();
  client.close();
  ui.stop();
}

async function sessionCommand(): Promise<void> {
  const action = positionals[0] ?? "list";
  if (action === "list") {
    for (const session of await client.listSessions())
      console.log(
        `${session.id}\t${session.mode}\t${session.title}\t${session.model.provider}/${session.model.id}\t${session.workspace ?? "-"}`,
      );
  } else if (action === "create") {
    const mode = valueAfter("--mode") === "assistant" ? "assistant" : "workspace";
    console.log(
      (await client.createSession({ mode, ...(positionals[1] ? { title: positionals[1] } : {}) })).id,
    );
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
  else throw new Error("uma task start <prompt>|list|show <id>|cancel <id>");
}

async function memoryCommand(): Promise<void> {
  const action = positionals[0] ?? "list";
  if (action === "list" || action === "review") {
    const status = action === "review" ? "candidate" : undefined;
    for (const fact of await client.listMemoryFacts(status))
      console.log(`${fact.id}\t${fact.status}\t${fact.confidence.toFixed(2)}\t${fact.content}`);
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
  const accepted = await client.sendMessage(session.id, prompt);
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
  if (positionals[0] === "add" && positionals[1] && positionals[2])
    await client.indexKnowledge(positionals[1], positionals[2]);
  else if (positionals[0] !== "list" && positionals.length)
    throw new Error("uma knowledge list|add <name> <path>");
  for (const item of await client.listKnowledge())
    console.log(`${item.id}\t${item.name}\t${item.documentCount}\t${item.path}`);
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
  else if (command === "memory") await memoryCommand();
  else if (command === "audit") await auditCommand();
  else if (command === "sync") await syncCommand();
  else if (command === "channel") await doctorCommand();
  else
    console.log(
      "UmaAgent CLI\n\numa chat [--session=ID] [--server=URL] [--token=TOKEN]\numa run --json <prompt>\numa run resume|checkpoints|actions|decide ...\numa sync <session-id>\numa session list|create|delete|rename\numa task start|list|show|cancel\numa memory list|review|accept|reject\numa audit run <run-id>\numa skill list|refresh\numa mcp status\numa knowledge list|add\numa doctor",
    );
  client.close();
}

await main().catch((error: unknown) => {
  client.close();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
