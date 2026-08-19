import { createModels, createProvider, envApiKeyAuth, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelRef } from "@uma-agent/protocol";
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
  };
}

export class ModelRegistry {
  readonly models: Models;

  constructor(config: UmaConfig) {
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

  list(): ModelRef[] {
    return this.models.getModels().map((model) => ({ provider: model.provider, id: model.id }));
  }
}
