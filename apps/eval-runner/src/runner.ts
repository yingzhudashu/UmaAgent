import type {
  AuditRecord,
  InteractionMode,
  Run,
  RunAction,
  SessionEventPage,
  SessionSnapshot,
} from "@uma-agent/protocol";

export interface EvalCase {
  name: string;
  category?: "security" | "prompt_injection" | "tool_selection" | "schema" | "regression" | "cost";
  prompt: string;
  mode: InteractionMode;
  expectedStatus: Run["status"];
  expectedIncludes?: string;
  expectedRoute?: Run["route"];
  expectedTool?: string;
  expectedApproval?: boolean;
  expectedDurableEvent?: string;
}

export interface EvalClient {
  createSession(input: { title: string }): Promise<{ id: string }>;
  sendMessage(
    sessionId: string,
    text: string,
    input: { mode: NonNullable<EvalCase["mode"]> },
  ): Promise<{ runId: string }>;
  waitForRun(runId: string, options: { pollMs: number }): Promise<Run>;
  getSession(id: string): Promise<SessionSnapshot>;
  listAudit(runId: string): Promise<AuditRecord[]>;
  listRunActions(runId: string): Promise<RunAction[]>;
  getSessionEvents(sessionId: string, after: number, limit?: number): Promise<SessionEventPage>;
}

export interface EvalResult {
  name: string;
  category: NonNullable<EvalCase["category"]>;
  passed: boolean;
  durationMs: number;
  runId?: string;
  status?: Run["status"];
  error?: string;
}

export async function evaluateSuite(client: EvalClient, cases: EvalCase[]): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const item of cases) {
    const startedAt = Date.now();
    const category = item.category ?? "regression";
    try {
      const session = await client.createSession({ title: `Eval: ${item.name}` });
      const accepted = await client.sendMessage(session.id, item.prompt, {
        mode: item.mode,
      });
      const run = await client.waitForRun(accepted.runId, { pollMs: 50 });
      const snapshot = await client.getSession(session.id);
      const audit = await client.listAudit(run.id);
      const actions = await client.listRunActions(run.id);
      const events = await client.getSessionEvents(session.id, 0, 1_000);
      const output = snapshot.transcript
        .filter((entry) => entry.runId === run.id && entry.role === "assistant")
        .map((entry) => entry.content)
        .join("\n");
      const passed =
        run.status === item.expectedStatus &&
        (item.expectedIncludes === undefined || output.includes(item.expectedIncludes)) &&
        (item.expectedRoute === undefined || run.route === item.expectedRoute) &&
        (item.expectedTool === undefined ||
          audit.some((entry) => entry.kind === "tool" && entry.name === item.expectedTool)) &&
        (item.expectedApproval === undefined ||
          actions.some((action) =>
            ["prepared", "rejected", "completed", "acknowledged"].includes(action.status),
          ) === item.expectedApproval) &&
        (item.expectedDurableEvent === undefined ||
          events.events.some((event) => event.type === item.expectedDurableEvent));
      results.push({
        name: item.name,
        category,
        passed,
        durationMs: Date.now() - startedAt,
        runId: run.id,
        status: run.status,
        ...(!passed ? { error: "Observed result did not match the expected public outcome" } : {}),
      });
    } catch (error) {
      results.push({
        name: item.name,
        category,
        passed: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function junitReport(results: EvalResult[]): string {
  const escapeXml = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const failures = results.filter((result) => !result.passed).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="UmaAgent Faux" tests="${results.length}" failures="${failures}">\n${results
    .map(
      (result) =>
        `  <testcase name="${escapeXml(result.name)}">${result.passed ? "" : `<failure message="${escapeXml(result.error ?? "failed")}"/>`}</testcase>`,
    )
    .join("\n")}\n</testsuite>\n`;
}
