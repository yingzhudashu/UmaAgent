import { parentPort, workerData } from "node:worker_threads";
import { parseOffice } from "officeparser";

const path = String(workerData);

try {
  const document = await parseOffice(path, {
    extractAttachments: false,
    includeRawContent: false,
    ocr: false,
  });
  parentPort?.postMessage({ ok: true, text: document.toText() });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
