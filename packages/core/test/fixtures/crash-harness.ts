import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { Approval } from "@uma-agent/protocol";
import { UmaRuntime } from "../../src/runtime.js";

const stateDir = process.argv[2];
const point = process.argv[3];
if (!stateDir || !point) throw new Error("state directory and crash point are required");
const [faultPoint] = point.split(":");
if (!faultPoint) throw new Error("fault point is required");
await mkdir(resolve(stateDir, "workspace"), { recursive: true });

process.env.NODE_ENV = "test";
process.env.UMA_TEST_FAULT_MODE = "abort";
process.env.UMA_TEST_FAULT_POINT = faultPoint;

const config = {
  server: {
    host: "127.0.0.1",
    port: 0,
    stateDir,
    workspaceRoots: [resolve(stateDir, "workspace")],
    webOrigins: [],
    maxUploadBytes: 1024 * 1024,
  },
  auth: { webSessionHours: 1 },
  models: [
    {
      provider: "faux",
      id: "model",
      name: "Faux",
      api: "openai-responses" as const,
      baseUrl: "http://127.0.0.1:9/v1",
      apiKeyEnv: "UMA_TEST_KEY",
      reasoning: false,
      tools: true,
      vision: false,
      structuredOutput: true,
      contextWindow: 100_000,
      maxTokens: 4_096,
    },
  ],
  defaultModel: { provider: "faux", id: "model" },
  defaultThinkingLevel: "off" as const,
  roles: {
    default: { provider: "faux", id: "model" },
    reasoning: { provider: "faux", id: "model" },
    fast: { provider: "faux", id: "model" },
    vision: { provider: "faux", id: "model" },
  },
  skillsDirs: [],
  mcpServers: [],
  runtime: { maxParallelSessions: 1, approvalTimeoutMs: 5_000, toolTimeoutMs: 5_000 },
  imageGeneration: { baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "UMA_IMAGE_TEST_KEY" },
};

const runtime = new UmaRuntime(config);
const faux = fauxProvider({
  provider: "faux",
  models: [{ id: "model", contextWindow: 100_000, maxTokens: 4_096 }],
  tokensPerSecond: 100_000,
});
const responses: FauxResponseStep[] =
  point === "verify.completed"
    ? [
        fauxAssistantMessage(JSON.stringify({ taskClass: "complex" })),
        fauxAssistantMessage(
          JSON.stringify({
            taskClass: "complex",
            goal: "exercise verification recovery",
            reasoningSummary: "A deterministic recovery plan is required.",
            successCriteria: ["complete the step"],
            assumptions: [],
            questions: [],
            steps: ["complete the deterministic step"],
          }),
        ),
        fauxAssistantMessage("step completed"),
        fauxAssistantMessage(JSON.stringify({ accepted: true, feedback: "" })),
      ]
    : point === "checkpoint.created"
      ? [
          fauxAssistantMessage(JSON.stringify({ taskClass: "complex" })),
          fauxAssistantMessage(
            JSON.stringify({
              taskClass: "complex",
              goal: "exercise checkpoint recovery",
              reasoningSummary: "A deterministic recovery plan is required.",
              successCriteria: ["complete the step"],
              assumptions: [],
              questions: [],
              steps: ["complete the deterministic step"],
            }),
          ),
          fauxAssistantMessage("step completed"),
        ]
      : [
          fauxAssistantMessage(JSON.stringify({ taskClass: "simple" })),
          ...(point.startsWith("tool.") && point.includes("read")
            ? [fauxAssistantMessage([fauxToolCall("memory_search", { query: "crash" })])]
            : point.startsWith("tool.") && point.includes("side-effect")
              ? [
                  fauxAssistantMessage([
                    fauxToolCall("memory_write", { scope: "session", content: "crash recovery fact" }),
                  ]),
                ]
              : [fauxAssistantMessage("runtime crash boundary")]),
        ];
faux.setResponses(responses);
runtime.models.models.setProvider(faux.provider);
await runtime.start();
runtime.database.db
  .prepare("INSERT INTO users(id,role,status,created_at,updated_at) VALUES(?,?,?,?,?)")
  .run("test-user", "user", "active", Date.now(), Date.now());
runtime.subscribe((event) => {
  if (
    event.type === "run.awaiting_input" &&
    (event.payload as { confirmationRequired?: boolean }).confirmationRequired
  ) {
    runtime.confirmPlan(event.runId as string);
  }
  if (point.includes("side-effect") && event.type === "approval.requested") {
    runtime.resolveApproval((event.payload as Approval).id, true);
  }
});
const session = await runtime.createSession({}, "test-user");
runtime.sendMessage(session.id, {
  messageId: `message-${point.replaceAll(".", "-")}`,
  text: `crash at ${point}`,
  mode: point === "verify.completed" || point === "checkpoint.created" ? "plan" : "agent",
});

await new Promise((_, reject) =>
  setTimeout(() => reject(new Error(`Runtime did not reach crash point: ${point}`)), 15_000),
);
