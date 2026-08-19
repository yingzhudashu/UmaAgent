import { loadConfig, UmaRuntime } from "@uma-agent/core";
import { createServer } from "./app.js";

const configPath =
  process.argv.find((arg) => arg.startsWith("--config="))?.slice("--config=".length) ??
  process.env.UMA_CONFIG ??
  "uma.config.json";
const config = await loadConfig(configPath);
const runtime = new UmaRuntime(config);
await runtime.start();
const app = await createServer(runtime);
await app.listen({ host: config.server.host, port: config.server.port });

const shutdown = async () => {
  await app.close();
  await runtime.stop();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
