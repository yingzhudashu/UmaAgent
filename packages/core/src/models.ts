import { createModels, createProvider, envApiKeyAuth, type Model, type Models } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelRef, ModelSnapshot } from "@uma-agent/protocol";
import type { UmaConfig, UmaModelConfig } from "./types.js";

function toModel(config: UmaModelConfig): Model<UmaModelConfig["api"]> {
  return {
    id: config.id,
    name: config.name,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    // The configured OpenAI-compatible gateway rejects the SDK's default
    // `OpenAI/JS ...` user agent. Keep the request identifiable without
    // exposing the SDK implementation detail upstream.
    headers: { "user-agent": "UmaAgent/1.0", accept: "application/json" },
    compat: { sessionAffinityFormat: "openai-nosession" },
  };
}

export class ModelRegistry {
  readonly models: Models;

  constructor(private readonly config: UmaConfig) {
    const models = createModels();
    const groups = new Map<string, UmaModelConfig[]>();
    for (const model of config.models)
      groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
    for (const [providerId, entries] of groups) {
      const first = entries[0];
      if (!first) continue;
      if (entries.some((entry) => entry.baseUrl !== first.baseUrl || entry.apiKeyEnv !== first.apiKeyEnv)) {
        throw new Error(`Models for provider ${providerId} must share baseUrl and apiKeyEnv`);
      }
      models.setProvider(
        createProvider({
          id: providerId,
          name: providerId,
          baseUrl: first.baseUrl,
          auth: { apiKey: envApiKeyAuth(`${providerId} API key`, [first.apiKeyEnv]) },
          models: entries.map(toModel),
          api: {
            "openai-responses": openAIResponsesApi(),
            "openai-completions": openAICompletionsApi(),
            "anthropic-messages": anthropicMessagesApi(),
            "google-generative-ai": googleGenerativeAIApi(),
          },
        }),
      );
    }
    this.models = models;
  }

  get(ref: ModelRef): Model<UmaModelConfig["api"]> {
    const model = this.models.getModel(ref.provider, ref.id);
    if (!model) throw new Error(`Unknown model ${ref.provider}/${ref.id}`);
    return model as Model<UmaModelConfig["api"]>;
  }

  forRole(role: keyof UmaConfig["roles"]): Model<UmaModelConfig["api"]> {
    return this.get(this.config.roles[role]);
  }

  list(): ModelRef[] {
    return this.models.getModels().map((model) => ({ provider: model.provider, id: model.id }));
  }

  snapshot(ref: ModelRef): ModelSnapshot {
    const model = this.get(ref);
    const configured = this.config.models.find(
      (entry) => entry.provider === ref.provider && entry.id === ref.id,
    );
    if (!configured) throw new Error(`Unknown model ${ref.provider}/${ref.id}`);
    return {
      ref,
      name: model.name,
      api: model.api,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      capabilities: {
        tools: configured.tools,
        vision: configured.vision,
        reasoning: configured.reasoning,
        structuredOutput: configured.structuredOutput,
      },
    };
  }

  fromSnapshot(snapshot: ModelSnapshot): Model<UmaModelConfig["api"]> {
    const current = this.get(snapshot.ref);
    return {
      ...current,
      name: snapshot.name,
      api: snapshot.api as UmaModelConfig["api"],
      contextWindow: snapshot.contextWindow,
      maxTokens: snapshot.maxOutputTokens,
      reasoning: snapshot.capabilities.reasoning,
      input: snapshot.capabilities.vision ? ["text", "image"] : ["text"],
    };
  }
}
