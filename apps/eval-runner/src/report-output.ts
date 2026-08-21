import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function writeEvaluationOutputs(input: {
  junitPath?: string;
  junit: string;
  historyPath?: string;
  historyEntry: string;
}): Promise<void> {
  if (input.junitPath) {
    await ensureParent(input.junitPath);
    await writeFile(input.junitPath, input.junit, "utf8");
  }
  if (input.historyPath) {
    await ensureParent(input.historyPath);
    await appendFile(input.historyPath, `${input.historyEntry}\n`, "utf8");
  }
}
