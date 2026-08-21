import { contentText } from "@earendil-works/pi-ai";
import type { QualityIssue } from "@uma-agent/protocol";
import Type, { type TSchema } from "typebox";
import Value from "typebox/value";
import type { RunPreflight } from "./run-preflight.js";
import { extractJson } from "./runtime-support.js";

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

/** Tool-free, bounded answer review and revision calls. */
export class RunQualityService {
  constructor(private readonly preflight: RunPreflight) {}

  private async json<T>(
    runId: string,
    systemPrompt: string,
    prompt: string,
    schema: TSchema,
    signal: AbortSignal,
  ): Promise<T> {
    let response = await this.preflight.complete(runId, "reasoning", systemPrompt, prompt, signal, true);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (response.stopReason === "error" || response.stopReason === "aborted")
        throw new Error(response.errorMessage ?? "Quality model call failed");
      try {
        const value = extractJson(contentText(response.content));
        if (Value.Check(schema, value)) return value as T;
      } catch {
        // A single format-repair request is allowed and has no tools or side effects.
      }
      if (attempt === 1) break;
      response = await this.preflight.complete(
        runId,
        "reasoning",
        "Return only one JSON value matching the requested schema. No Markdown or commentary.",
        prompt,
        signal,
        true,
      );
    }
    throw new Error("Provider contract error: invalid quality response");
  }

  async review(
    runId: string,
    question: string,
    answer: string,
    feedback: string,
    signal: AbortSignal,
  ): Promise<ReviewIteration[]> {
    const iterations: ReviewIteration[] = [];
    let current = answer;
    for (let iteration = 1; iteration <= 3; iteration++) {
      const result = await this.json<ReviewIteration>(
        runId,
        "Review the public answer for factual accuracy, logic, completeness and clarity. Return JSON {passed,issues:[{type,description}],suggestions:string[],improvedAnswer?:string}. Do not use tools and do not expose hidden reasoning.",
        `Question:\n${question.slice(0, 10_000)}\n\nAnswer:\n${current.slice(0, 30_000)}${feedback ? `\n\nUser feedback:\n${feedback.slice(0, 10_000)}` : ""}`,
        ReviewSchema,
        signal,
      );
      iterations.push(result);
      if (result.passed || result.issues.length === 0 || !result.improvedAnswer) break;
      current = result.improvedAnswer;
    }
    return iterations;
  }

  improve(
    runId: string,
    question: string,
    answer: string,
    suggestions: string[],
    signal: AbortSignal,
  ): Promise<{ improvedAnswer: string }> {
    return this.json(
      runId,
      "Improve the public answer using every supplied suggestion. Preserve its intent and style. Return JSON {improvedAnswer:string}. Do not use tools or expose hidden reasoning.",
      `Question:\n${question.slice(0, 10_000)}\n\nAnswer:\n${answer.slice(0, 30_000)}\n\nSuggestions:\n${suggestions.map((item) => `- ${item}`).join("\n")}`,
      ImproveSchema,
      signal,
    );
  }
}
