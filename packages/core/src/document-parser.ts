import { Worker } from "node:worker_threads";

export function parseDocument(path: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./document-worker.js", import.meta.url), {
      workerData: path,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Document parsing timed out"));
    }, timeoutMs);
    worker.once("message", (message: { ok?: boolean; text?: string; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.ok && typeof message.text === "string") resolve(message.text);
      else reject(new Error(message.error ?? "Document parsing failed"));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Document parser exited with code ${code}`));
      }
    });
  });
}
