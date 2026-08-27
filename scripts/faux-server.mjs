import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { UmaRuntime } from "@uma-agent/core";
import { createServer } from "../apps/server/dist/app.js";

const port = Number(process.env.UMA_FAUX_PORT ?? 3210);
const tokenSecret = process.env.UMA_FAUX_TOKEN ?? "faux-local-token-012345678901234567890123";
const tokenId = "00000000-0000-4000-8000-000000000001";
const webOrigins = (process.env.UMA_FAUX_WEB_ORIGINS ?? `http://127.0.0.1:${port},http://127.0.0.1:3211`)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const stateDir = process.env.UMA_FAUX_STATE
  ? resolve(process.env.UMA_FAUX_STATE)
  : await mkdtemp(join(tmpdir(), "uma-faux-"));
if (process.env.UMA_FAUX_RESET_STATE === "1") {
  await rm(stateDir, { recursive: true, force: true });
}

const config = {
  server: {
    host: "127.0.0.1",
    port,
    stateDir,
    workspaceRoots: [resolve(".")],
    webOrigins,
    maxUploadBytes: 20 * 1024 * 1024,
  },
  auth: { webSessionHours: 24 },
  models: [
    {
      provider: "faux",
      id: "faux-1",
      name: "Faux",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKeyEnv: "UMA_FAUX_KEY",
      reasoning: false,
      tools: true,
      vision: false,
      structuredOutput: true,
      contextWindow: 100_000,
      maxTokens: 4_096,
    },
  ],
  defaultModel: { provider: "faux", id: "faux-1" },
  defaultThinkingLevel: "off",
  roles: {
    default: { provider: "faux", id: "faux-1" },
    reasoning: { provider: "faux", id: "faux-1" },
    fast: { provider: "faux", id: "faux-1" },
    vision: { provider: "faux", id: "faux-1" },
  },
  skillsDirs: [resolve(".uma-faux/skills")],
  mcpServers: [],
  runtime: { maxParallelSessions: 4, approvalTimeoutMs: 120_000, toolTimeoutMs: 60_000 },
};

const runtime = new UmaRuntime(config);
const faux = fauxProvider({
  provider: "faux",
  models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 4_096 }],
  tokensPerSecond: 80,
});
const response = (context) => {
  const latest = [...context.messages].reverse().find((message) => message.role === "user");
  const content =
    typeof latest?.content === "string"
      ? latest.content
      : Array.isArray(latest?.content)
        ? latest.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n")
        : "your request";
  // Dynamic session context is prepended to the request in the real runtime.
  // Keep Faux assertions focused on the actual user request text.
  const requestText = content.replace(/<([a-z_]+)>[\s\S]*?<\/\1>\s*/g, "").trim();
  if (context.systemPrompt.includes("Classify the latest user request")) {
    const taskClass = requestText.includes("FAUX_CLARIFY")
      ? "standard"
      : requestText.includes("deterministic plan")
        ? "complex"
        : "simple";
    return fauxAssistantMessage(JSON.stringify({ taskClass }));
  }
  if (context.systemPrompt.includes("Specify the latest request execution contract")) {
    const clarify = requestText.includes("FAUX_CLARIFY");
    const planned = requestText.includes("deterministic plan");
    return fauxAssistantMessage(
      JSON.stringify({
        taskClass: planned ? "complex" : "standard",
        goal: clarify ? "Clarify the target" : "Complete the deterministic evaluation",
        reasoningSummary: `Deterministic ${planned ? "plan" : "direct"} evaluation strategy.`,
        successCriteria: ["Produce the expected public evaluation result"],
        assumptions: [],
        questions: clarify ? ["Which FAUX_CLARIFY target should be used?"] : [],
        steps: planned ? ["Produce the first plan result", "Produce the final plan result"] : [],
      }),
    );
  }
  if (context.systemPrompt.includes("Verify whether the latest result"))
    return fauxAssistantMessage(JSON.stringify({ accepted: true, feedback: "" }));
  if (context.systemPrompt.includes("Extract durable user facts")) return fauxAssistantMessage("[]");
  if (requestText.includes("configured deterministic read tool")) {
    if (context.messages.some((message) => message.role === "toolResult"))
      return fauxAssistantMessage("FAUX_TOOL_RESULT");
    return fauxAssistantMessage([fauxToolCall("memory_search", { query: "deterministic", limit: 1 })]);
  }
  if (requestText.includes("FAUX_SECURITY_TEST")) return fauxAssistantMessage("FAUX_SECURITY_SAFE");
  if (requestText.includes("FAUX_PROMPT_INJECTION")) return fauxAssistantMessage("FAUX_INJECTION_REFUSED");
  if (requestText.includes("Execute only plan step 1")) return fauxAssistantMessage("FAUX_PLAN_STEP_1");
  if (requestText.includes("Execute only plan step 2")) return fauxAssistantMessage("FAUX_PLAN_STEP_2");
  return fauxAssistantMessage(`Faux Core received: ${requestText.slice(0, 300)}`);
};
faux.setResponses(Array.from({ length: 500 }, () => response));
runtime.models.models.setProvider(faux.provider);
await runtime.start();
const fauxUser = runtime.database.createUser("admin");
const token = `uma_pat_${tokenId}_${tokenSecret}`;
runtime.database.putAuthToken({
  id: tokenId,
  userId: fauxUser.id,
  tokenHash: createHash("sha256").update(tokenSecret).digest("hex"),
  label: "faux-e2e",
  scopes: ["user"],
  expiresAt: Date.now() + 86_400_000,
});
const app = await createServer(runtime);
await app.listen({ host: config.server.host, port });
console.log(`UmaAgent faux server: http://127.0.0.1:${port} (token: ${token})`);

const shutdown = async () => {
  await app.close();
  await runtime.stop();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
