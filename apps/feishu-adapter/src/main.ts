import { startFeishuService } from "./service.js";

await startFeishuService(process.argv.find((arg) => arg.startsWith("--config="))?.slice(9));
