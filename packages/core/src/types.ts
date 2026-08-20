import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRef } from "@uma-agent/protocol";

export type ModelApi =
  | "openai-responses"
  | "openai-completions"
  | "anthropic-messages"
  | "google-generative-ai";

export interface UmaModelConfig {
  provider: string;
  id: string;
  name: string;
  api: ModelApi;
  baseUrl: string;
  apiKeyEnv: string;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface UmaConfig {
  server: {
    host: string;
    port: number;
    stateDir: string;
    workspaceRoots: string[];
    webOrigins: string[];
    maxUploadBytes: number;
  };
  auth: { tokenEnv: string; webSessionHours: number };
  models: UmaModelConfig[];
  defaultModel: ModelRef;
  defaultThinkingLevel: ThinkingLevel;
  skillsDirs: string[];
  mcpServers: McpServerConfig[];
  runtime: { maxParallelSessions: number; approvalTimeoutMs: number; toolTimeoutMs: number };
  roles: { default: ModelRef; reasoning: ModelRef; fast: ModelRef; vision: ModelRef };
}

export interface PreflightDecision {
  taskClass: "simple" | "standard" | "complex";
  route: "direct" | "clarify" | "plan";
  goal: string;
  reasoningSummary: string;
  successCriteria: string[];
  questions: string[];
  steps: string[];
}

export interface StoredAgentMessage {
  id: string;
  sequence: number;
  message: AgentMessage;
}

export interface ContextSummary {
  sessionId: string;
  throughSequence: number;
  content: string;
  updatedAt: number;
}

export interface RuntimeHealth {
  activeRuns: number;
  started: boolean;
}
