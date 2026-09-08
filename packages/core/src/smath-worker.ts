import { formatTraceparent, type TraceParent } from "@uma-agent/telemetry";

export type SmathOperation = "list" | "read" | "create" | "update" | "calculate" | "export" | "delete";

export interface SmathJobResult {
  operation: SmathOperation;
  path?: string;
  output?: string;
  file?: { name: string; mimeType: string; dataBase64: string };
}

export class SmathWorkerClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  static fromEnvironment(): SmathWorkerClient | undefined {
    const url = process.env.UMA_SMATH_WORKER_URL?.trim();
    const token = process.env.UMA_SMATH_WORKER_TOKEN?.trim();
    return url && token ? new SmathWorkerClient(url.replace(/\/$/, ""), token) : undefined;
  }

  async execute(
    ownerId: string,
    input: { operation: SmathOperation; path?: string; content?: string; format?: "pdf" | "html" },
    signal?: AbortSignal,
    traceParent?: TraceParent,
  ): Promise<SmathJobResult> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
    if (traceParent) headers.traceparent = formatTraceparent(traceParent);
    const response = await fetch(`${this.url}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ownerId, ...input }),
      ...(signal ? { signal } : {}),
    });
    const body = (await response.json().catch(() => undefined)) as
      | { error?: string; result?: SmathJobResult }
      | undefined;
    if (!response.ok || !body?.result)
      throw new Error(body?.error ?? `SMath worker failed: HTTP ${response.status}`);
    return body.result;
  }
}
