#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Box, Input, ProcessTerminal, Spacer, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { UmaClient } from "@uma-agent/client";
import type { AgentEventEnvelope, Approval, Session, SessionSnapshot } from "@uma-agent/protocol";

const args = process.argv.slice(2);
const command = args[0] ?? "chat";
const valueAfter = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const positionals = args.slice(1).filter((arg) => !arg.startsWith("--"));
const server = valueAfter("--server") ?? process.env.UMA_SERVER_URL ?? "http://127.0.0.1:3210";
const token = valueAfter("--token") ?? process.env.UMA_TOKEN;
const client = new UmaClient({ baseUrl: server, ...(token ? { token } : {}) });

function renderTranscript(snapshot: SessionSnapshot): string {
  return snapshot.transcript
    .slice(-14)
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
    const run = snapshot.runs.at(-1);
    header.setText(
      `UmaAgent  ${active.title}\n${active.model.provider}/${active.model.id}  ${active.workspace}`,
    );
    transcript.setText(renderTranscript(snapshot) || "No messages yet.");
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
        "/new  /sessions  /use <id>  /rename <title>  /model <provider/id>  /attach <path>  /approve <id> yes|no  /cancel  /exit",
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
      await client.cancel(active.id);
      return;
    }
    if (value.startsWith("/approve ")) {
      const [, id, answer] = value.split(/\s+/);
      if (!id || !approvals.has(id)) throw new Error("Approval is not pending");
      await client.resolveApproval(id, answer === "yes" || answer === "y");
      approvals.delete(id);
      return;
    }
    await client.sendMessage(
      active.id,
      value,
      attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {},
    );
    attachmentIds.splice(0);
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
        `${session.id}\t${session.title}\t${session.model.provider}/${session.model.id}\t${session.workspace}`,
      );
  } else if (action === "create") {
    console.log((await client.createSession(positionals[1] ? { title: positionals[1] } : {})).id);
  } else if (action === "delete" && positionals[1]) await client.deleteSession(positionals[1]);
  else if (action === "rename" && positionals[1] && positionals[2])
    await client.updateSession(positionals[1], { title: positionals.slice(2).join(" ") });
  else throw new Error("uma session list|create [title]|delete <id>|rename <id> <title>");
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

async function main(): Promise<void> {
  if (command === "chat") return chat();
  if (command === "session" || command === "sessions") await sessionCommand();
  else if (command === "skill" || command === "skills") await skillCommand();
  else if (command === "mcp") await mcpCommand();
  else if (command === "knowledge") await knowledgeCommand();
  else if (command === "doctor") console.log(JSON.stringify(await client.health(), null, 2));
  else
    console.log(
      "UmaAgent CLI\n\numa chat [--session=ID] [--server=URL] [--token=TOKEN]\numa session list|create|delete|rename\numa skill list|refresh\numa mcp status\numa knowledge list|add\numa doctor",
    );
  client.close();
}

await main().catch((error: unknown) => {
  client.close();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
