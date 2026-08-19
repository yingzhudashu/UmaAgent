import { resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { UmaRuntime } from "@uma-agent/core";
import { createServer } from "../apps/server/dist/app.js";

const port = Number(process.env.UMA_FAUX_PORT ?? 3210);
const token = process.env.UMA_FAUX_TOKEN ?? "uma-dev-token";
process.env.UMA_FAUX_TOKEN = token;

const config = {
  server: {
    host: "127.0.0.1",
    port,
    stateDir: resolve(process.env.UMA_FAUX_STATE ?? ".uma-faux"),
    workspaceRoots: [resolve(".")],
    webOrigins: [],
    maxUploadBytes: 20 * 1024 * 1024,
  },
  auth: { tokenEnv: "UMA_FAUX_TOKEN", webSessionHours: 24 },
  models: [
    {
      provider: "faux",
      id: "faux-1",
      name: "Faux",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKeyEnv: "UMA_FAUX_KEY",
      reasoning: false,
      contextWindow: 100_000,
      maxTokens: 4_096,
    },
  ],
  defaultModel: { provider: "faux", id: "faux-1" },
  defaultThinkingLevel: "off",
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
  if (context.systemPrompt.includes("You route an agent request")) {
    return fauxAssistantMessage(
      JSON.stringify({
        route: "direct",
        goal: "Respond to the user",
        reasoningSummary: "Direct response is sufficient.",
        successCriteria: ["Address the request"],
        questions: [],
        steps: [],
      }),
    );
  }
  if (context.systemPrompt.includes("Verify whether the result"))
    return fauxAssistantMessage(JSON.stringify({ accepted: true, feedback: "" }));
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
  return fauxAssistantMessage(`Faux Core received: ${content.slice(0, 300)}`);
};
faux.setResponses(Array.from({ length: 500 }, () => response));
runtime.models.models.setProvider(faux.provider);
await runtime.start();
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
