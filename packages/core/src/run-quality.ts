import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { QualityIssue } from "@uma-agent/protocol";
import Type, { type TSchema } from "typebox";
import Value from "typebox/value";
import type { ModelCallService } from "./model-calls.js";
import { extractJson } from "./runtime-support.js";
import type { TraceContext } from "./trace.js";

const ReviewSchema = Type.Object(
  {
    passed: Type.Boolean(),
    issues: Type.Array(
      Type.Object(
        {
          type: Type.Union([
            Type.Literal("knowledge_error"),
            Type.Literal("logic_error"),
            Type.Literal("clarity"),
            Type.Literal("omission"),
          ]),
          description: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    suggestions: Type.Array(Type.String()),
    improvedAnswer: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ImproveSchema = Type.Object(
  { improvedAnswer: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export interface ReviewIteration {
  passed: boolean;
  issues: QualityIssue[];
  suggestions: string[];
  improvedAnswer?: string;
}

export interface QualityContext {
  runId: string;
  sessionId: string;
  messages: AgentMessage[];
  signal: AbortSignal;
  contextSummarySequence?: number;
  trace?: TraceContext;
}

function instruction(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() };
}

/** Tool-free bounded review calls that preserve the target conversation prefix. */
export class RunQualityService {
  constructor(private readonly modelCalls: ModelCallService) {}

  private async json<T>(
    context: QualityContext,
    purpose: string,
    systemPrompt: string,
    prompt: string,
    schema: TSchema,
  ): Promise<T> {
    const base = [...context.messages, instruction(prompt)];
    let response = await this.modelCalls.complete({
      runId: context.runId,
      sessionId: context.sessionId,
      role: "reasoning",
      purpose,
      systemPrompt,
      messages: base,
      signal: context.signal,
      ...(context.contextSummarySequence !== undefined
        ? { contextSummarySequence: context.contextSummarySequence }
        : {}),
      ...(context.trace ? { trace: context.trace } : {}),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (response.stopReason === "error" || response.stopReason === "aborted")
        throw new Error(response.errorMessage ?? "Quality model call failed");
      try {
        const value = extractJson(contentText(response.content));
        if (Value.Check(schema, value)) return value as T;
      } catch {
        // One repair turn is appended after the same stable conversation prefix.
      }
      if (attempt === 1) break;
      response = await this.modelCalls.complete({
        runId: context.runId,
        sessionId: context.sessionId,
        role: "reasoning",
        purpose: `${purpose}.repair`,
        systemPrompt,
        messages: [
          ...base,
          instruction("Return only one JSON value matching the requested schema. No Markdown or commentary."),
        ],
        signal: context.signal,
        ...(context.contextSummarySequence !== undefined
          ? { contextSummarySequence: context.contextSummarySequence }
          : {}),
        ...(context.trace ? { trace: context.trace } : {}),
      });
    }
    throw new Error("Provider contract error: invalid quality response");
  }

  async review(
    context: QualityContext,
    question: string,
    answer: string,
    feedback: string,
  ): Promise<ReviewIteration[]> {
    const iterations: ReviewIteration[] = [];
    let current = answer;
    for (let iteration = 1; iteration <= 3; iteration++) {
      const result = await this.json<ReviewIteration>(
        context,
        "quality.review",
        "Review the public answer in its conversation for factual accuracy, logic, completeness and clarity. Return JSON {passed,issues:[{type,description}],suggestions:string[],improvedAnswer?:string}. Do not use tools and do not expose hidden reasoning.",
        `Target question:\n${question.slice(0, 10_000)}\n\nTarget answer:\n${current.slice(0, 30_000)}${feedback ? `\n\nUser feedback:\n${feedback.slice(0, 10_000)}` : ""}`,
        ReviewSchema,
      );
      iterations.push(result);
      if (result.passed || result.issues.length === 0 || !result.improvedAnswer) break;
      current = result.improvedAnswer;
    }
    return iterations;
  }

  improve(
    context: QualityContext,
    question: string,
    answer: string,
    suggestions: string[],
  ): Promise<{ improvedAnswer: string }> {
    return this.json(
      context,
      "quality.improve",
      "Improve the target public answer in its conversation using every supplied suggestion. Preserve its intent and style. Return JSON {improvedAnswer:string}. Do not use tools or expose hidden reasoning.",
      `Target question:\n${question.slice(0, 10_000)}\n\nTarget answer:\n${answer.slice(0, 30_000)}\n\nSuggestions:\n${suggestions.map((item) => `- ${item}`).join("\n")}`,
      ImproveSchema,
    );
  }
}
