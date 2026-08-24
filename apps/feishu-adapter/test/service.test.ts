import { createHash } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const core = {
    connectEvents: vi.fn(),
    close: vi.fn(),
    createSession: vi.fn(async () => ({ id: "session-1" })),
    sendMessage: vi.fn(async () => ({ run: { id: "run-1" } })),
    subscribeSessions: vi.fn(),
    getSession: vi.fn(),
    listRunActions: vi.fn(async () => []),
    upload: vi.fn(async () => ({ id: "attachment-1" })),
    resolveApproval: vi.fn(async () => ({})),
    resumeRun: vi.fn(async () => ({})),
    decideRunAction: vi.fn(async () => ({})),
  };
  const feishu = {
    createCard: vi.fn(async () => "feishu-card-1"),
    updateCard: vi.fn(async () => {}),
    downloadResource: vi.fn(async () => ({
      async *getReadableStream() {
        yield Buffer.from("attachment");
      },
    })),
  };
  const callbacks = new Map<string, Record<string, unknown>>();
  const conversations = new Map<string, Record<string, string>>();
  const store = {
    listPendingInbound: vi.fn(() => []),
    listConversations: vi.fn(() => []),
    latestConversationSequence: vi.fn(() => 0),
    getCard: vi.fn(),
    upsertCard: vi.fn(),
    markCardFailed: vi.fn(),
    putActionCallback: vi.fn((input: Record<string, unknown>) => {
      callbacks.set(String(input.tokenHash), { ...input, used: false });
    }),
    getConversation: vi.fn((key: Record<string, string>) =>
      conversations.get(`${key.tenant}:${key.chatType}:${key.chatId}:${key.threadRoot}`),
    ),
    createConversation: vi.fn((key: Record<string, string>, sessionId: string) => {
      const conversation = {
        id: "conversation-1",
        sessionId,
        chatId: key.chatId,
        chatType: key.chatType,
        threadRoot: key.threadRoot,
      };
      conversations.set(`${key.tenant}:${key.chatType}:${key.chatId}:${key.threadRoot}`, conversation);
      return conversation;
    }),
    attachInboundConversation: vi.fn(),
    markInbound: vi.fn(),
    startInbound: vi.fn(() => true),
    isOutboundMessage: vi.fn(() => false),
    claimInbound: vi.fn(() => ({ fresh: true, messageId: "uma-message-1" })),
    claimActionCallback: vi.fn((hash: string) => {
      const value = callbacks.get(hash);
      if (!value) return undefined;
      const result = { ...value };
      value.used = true;
      return result;
    }),
    releaseActionCallback: vi.fn((hash: string) => {
      const value = callbacks.get(hash);
      if (value) value.used = false;
    }),
    close: vi.fn(),
  };
  return {
    core,
    feishu,
    store,
    callbacks,
    conversations,
    inboundHandler: undefined as ((value: unknown) => Promise<void>) | undefined,
    cardHandler: undefined as ((value: unknown) => Promise<unknown>) | undefined,
    connectionOptions: undefined as Record<string, () => void> | undefined,
    eventListener: undefined as ((event: Record<string, unknown>) => void) | undefined,
  };
});
const userConfigPath = join(tmpdir(), "uma-feishu-vitest-config.json");

vi.mock("@uma-agent/client", () => ({
  UmaClient: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: the SDK constructor is replaced with an injected test gateway.
      return state.core;
    }
  },
}));

vi.mock("../src/gateways.js", () => ({
  LarkFeishuGateway: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: the production gateway is replaced with a deterministic fake.
      return state.feishu;
    }
  },
}));

vi.mock("../src/store.js", () => ({
  AdapterStore: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: the persistent store is replaced with an in-memory fake.
      return state.store;
    }
  },
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "feishu" },
  Client: class {},
  WSClient: class {
    constructor(options: Record<string, () => void>) {
      state.connectionOptions = options;
    }
    async start() {
      state.connectionOptions?.onReady?.();
    }
    close() {}
  },
  EventDispatcher: class {
    register(handlers: Record<string, (value: unknown) => Promise<void>>) {
      state.inboundHandler = handlers["im.message.receive_v1"];
      return this;
    }
  },
  CardActionHandler: class {
    constructor(_config: unknown, handler: (value: unknown) => Promise<unknown>) {
      state.cardHandler = handler;
    }
  },
  adaptDefault:
    () => (_req: unknown, res: { writeHead(code: number): unknown; end(value: string): void }) => {
      res.writeHead(200);
      res.end("ok");
    },
}));

import { startFeishuService } from "../src/service.js";

const run = (status: string, resume?: { state: string }) => ({
  id: "run-1",
  status,
  plan: [{ id: "step-1", title: "Current step", status: "running" }],
  ...(resume ? { resume } : {}),
});

const snapshot = (status = "running") => ({
  recentRuns: [run(status)],
  transcript: [{ role: "assistant", content: "Public answer" }],
  snapshotSequence: 7,
});

const inbound = (overrides: Record<string, unknown> = {}) => ({
  tenant_key: "tenant",
  sender: { sender_id: { open_id: "owner" } },
  message: {
    message_id: "external-1",
    chat_id: "chat-1",
    chat_type: "p2p",
    message_type: "text",
    content: JSON.stringify({ text: 'hello <at user_id="bot">bot</at>' }),
    ...overrides,
  },
});

const configure = (callbacks = true) => {
  const port = 34_000 + Math.floor(Math.random() * 10_000);
  writeFileSync(
    userConfigPath,
    JSON.stringify({
      version: 1,
      core: { serverUrl: "http://127.0.0.1:3000", token: "token" },
      feishu: {
        appId: "app",
        appSecret: "secret",
        ...(callbacks ? { verificationToken: "verification", encryptKey: "encrypt" } : {}),
        allowedOpenIds: ["owner"],
        host: "127.0.0.1",
        port,
        stateDir: join(tmpdir(), "uma-feishu-vitest-state"),
        maxAttachmentBytes: 25 * 1024 * 1024,
        mcpHost: "127.0.0.1",
        mcpPort: 3240,
      },
    }),
  );
};

describe("Feishu service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.callbacks.clear();
    state.conversations.clear();
    state.inboundHandler = undefined;
    state.cardHandler = undefined;
    state.eventListener = undefined;
    state.core.getSession.mockImplementation(async () => snapshot());
    state.core.listRunActions.mockResolvedValue([]);
    state.core.subscribeSessions.mockImplementation((_sessions, listener) => {
      state.eventListener = listener;
      return () => {};
    });
    state.store.claimInbound.mockReturnValue({ fresh: true, messageId: "uma-message-1" });
    state.store.startInbound.mockReturnValue(true);
    state.feishu.createCard.mockResolvedValue("feishu-card-1");
    configure();
  });

  it("processes inbound messages, renders durable events, and handles approval callbacks idempotently", async () => {
    const service = await startFeishuService(userConfigPath);
    if (!service.server.listening) await once(service.server, "listening");
    expect(service.adapter.health()).toMatchObject({ status: "ok", connected: true });

    await state.inboundHandler?.(inbound());
    await vi.waitFor(() => expect(state.core.sendMessage).toHaveBeenCalledOnce());
    expect(state.core.sendMessage).toHaveBeenCalledWith(
      "session-1",
      "hello",
      expect.objectContaining({
        messageId: "uma-message-1",
        source: expect.objectContaining({ adapter: "feishu", senderId: "owner" }),
      }),
    );

    state.eventListener?.({ type: "run.updated", payload: {}, sequence: 7 });
    await vi.waitFor(() => expect(state.feishu.createCard).toHaveBeenCalledOnce());
    state.eventListener?.({
      type: "approval.requested",
      payload: { id: "approval-1" },
      sequence: 8,
    });
    await vi.waitFor(() => expect(state.feishu.updateCard).toHaveBeenCalled());
    const content = String(state.feishu.updateCard.mock.calls.at(-1)?.[1]);
    const token = JSON.parse(content).elements.at(-1).actions.at(-1).value.token as string;
    expect(
      await state.cardHandler?.({ operator: { open_id: "other" }, action: { value: { token } } }),
    ).toMatchObject({ toast: { type: "error" } });
    expect(
      await state.cardHandler?.({ operator: { open_id: "owner" }, action: { value: { token } } }),
    ).toMatchObject({
      toast: { type: "success" },
    });
    expect(state.core.resolveApproval).toHaveBeenCalledWith("approval-1", true);
    expect(
      await state.cardHandler?.({ operator: { open_id: "owner" }, action: { value: { token } } }),
    ).toMatchObject({
      toast: { type: "success" },
    });
    expect(state.core.resolveApproval).toHaveBeenCalledOnce();

    await service.stop();
    expect(state.core.close).toHaveBeenCalledOnce();
    expect(state.store.close).toHaveBeenCalledOnce();
  });

  it("uploads image and file messages, recovers pending work, and renders action/resume terminal cards", async () => {
    state.store.listPendingInbound.mockReturnValueOnce([
      { externalId: "pending", messageId: "pending-uma", payload: inbound({ message_id: "pending" }) },
    ]);
    state.store.listConversations.mockReturnValueOnce([
      { id: "existing-conversation", sessionId: "existing-session", chatId: "existing-chat" },
    ]);
    const service = await startFeishuService(userConfigPath);
    if (!service.server.listening) await once(service.server, "listening");
    await vi.waitFor(() => expect(state.core.sendMessage).toHaveBeenCalled());

    await state.inboundHandler?.(
      inbound({
        message_id: "image-1",
        message_type: "image",
        content: JSON.stringify({ image_key: "image" }),
      }),
    );
    await vi.waitFor(() => expect(state.core.upload).toHaveBeenCalled());
    await state.inboundHandler?.(
      inbound({
        message_id: "file-1",
        message_type: "file",
        content: JSON.stringify({ file_key: "file", file_name: "notes.txt" }),
      }),
    );
    await vi.waitFor(() => expect(state.core.sendMessage).toHaveBeenCalledTimes(3));

    state.core.getSession.mockResolvedValueOnce({
      ...snapshot("interrupted"),
      recentRuns: [run("interrupted", { state: "needs_confirmation" })],
    });
    state.core.listRunActions.mockResolvedValueOnce([
      { id: "action-1", toolName: "shell", status: "uncertain" },
    ]);
    state.eventListener?.({ type: "run.resumed", payload: {}, sequence: 9 });
    await vi.waitFor(() => expect(state.feishu.createCard).toHaveBeenCalled());
    state.core.getSession.mockResolvedValueOnce({
      ...snapshot("interrupted"),
      recentRuns: [run("interrupted", { state: "available" })],
    });
    state.core.listRunActions.mockResolvedValueOnce([]);
    state.eventListener?.({ type: "run.updated", payload: {}, sequence: 10 });
    await vi.waitFor(() => expect(state.core.getSession).toHaveBeenCalledTimes(2));
    state.core.getSession.mockResolvedValueOnce(snapshot("completed"));
    state.eventListener?.({ type: "message.completed", payload: {}, sequence: 11 });
    await vi.waitFor(() =>
      expect(state.store.upsertCard).toHaveBeenCalledWith(
        expect.any(String),
        "run-1",
        7,
        "completed",
        expect.anything(),
      ),
    );
    await service.stop();
  });

  it("surfaces disabled callbacks, failed cards and failed callback decisions", async () => {
    configure(false);
    const service = await startFeishuService(userConfigPath);
    if (!service.server.listening) await once(service.server, "listening");
    const address = service.server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const callbackResponse = await fetch(`http://127.0.0.1:${address.port}/webhook/card`, { method: "POST" });
    expect(callbackResponse.status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${address.port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${address.port}/missing`)).status).toBe(404);

    await state.inboundHandler?.(inbound());
    await vi.waitFor(() => expect(state.core.sendMessage).toHaveBeenCalled());
    state.feishu.createCard.mockRejectedValue("rate limited");
    state.eventListener?.({ type: "run.updated", payload: {}, sequence: 12 });
    await vi.waitFor(() => expect(state.store.markCardFailed).toHaveBeenCalled(), { timeout: 5_000 });
    expect(await state.cardHandler?.({ operator: { open_id: "owner" }, action: {} })).toMatchObject({
      toast: { type: "error" },
    });
    expect(
      await state.cardHandler?.({ operator: { open_id: "owner" }, action: { value: { token: "missing" } } }),
    ).toMatchObject({
      toast: { type: "error" },
    });

    const token = "retry-token";
    const hash = createHash("sha256").update(token).digest("hex");
    state.callbacks.set(hash, {
      kind: "resume",
      targetId: "run-1",
      runId: "run-1",
      used: false,
    });
    state.core.resumeRun.mockRejectedValueOnce(new Error("offline"));
    await expect(
      state.cardHandler?.({ operator: { open_id: "owner" }, action: { value: { token } } }),
    ).rejects.toThrow("offline");
    expect(state.store.releaseActionCallback).toHaveBeenCalledWith(hash);
    await service.stop();
  });

  it("rejects missing and invalid environment configuration", async () => {
    await expect(startFeishuService(join(tmpdir(), "missing-user-config.json"))).rejects.toThrow(
      "Cannot read user config",
    );
    configure();
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        version: 1,
        core: { serverUrl: "http://127.0.0.1:3000", token: "token" },
        feishu: {
          appId: "app",
          appSecret: "secret",
          allowedOpenIds: ["owner"],
          host: "127.0.0.1",
          port: 0,
          stateDir: join(tmpdir(), "uma-feishu-vitest-state"),
          maxAttachmentBytes: 25 * 1024 * 1024,
        },
      }),
    );
    await expect(startFeishuService(userConfigPath)).rejects.toThrow("valid TCP port");
    configure();
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        version: 1,
        core: { serverUrl: "http://127.0.0.1:3000", token: "token" },
        feishu: {
          appId: "app",
          appSecret: "secret",
          allowedOpenIds: ["owner"],
          host: "127.0.0.1",
          port: 3220,
          stateDir: join(tmpdir(), "uma-feishu-vitest-state"),
          maxAttachmentBytes: 0,
        },
      }),
    );
    await expect(startFeishuService(userConfigPath)).rejects.toThrow("positive integer");
    configure();
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        version: 1,
        core: { serverUrl: "http://127.0.0.1:3000", token: "token" },
        feishu: {
          appId: "app",
          appSecret: "secret",
          allowedOpenIds: [],
          host: "127.0.0.1",
          port: 3220,
          stateDir: join(tmpdir(), "uma-feishu-vitest-state"),
          maxAttachmentBytes: 25 * 1024 * 1024,
        },
      }),
    );
    await expect(startFeishuService(userConfigPath)).rejects.toThrow("at least one Open ID");
  });
});
