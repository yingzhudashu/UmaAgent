import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { SendMessageRequest, Session } from "@uma-agent/protocol";
import type { ContextManager } from "./context-manager.js";
import type { UmaDatabase } from "./database.js";
import type { KnowledgeService } from "./knowledge.js";
import type { ModelRegistry } from "./models.js";
import type { PermissionPolicy } from "./permissions.js";
import type { SkillRegistry } from "./skills.js";
import type { PreflightDecision, UmaModelConfig } from "./types.js";

export interface AgentContext {
  model: Model<UmaModelConfig["api"]>;
  systemPrompt: string;
  prompt: string;
  images: ImageContent[];
  tools: AgentTool[];
  messages: Awaited<ReturnType<ContextManager["compact"]>>["messages"];
}

/** Rebuilds the public agent context from persisted server state. */
export class RunContextBuilder {
  constructor(
    private readonly database: UmaDatabase,
    private readonly models: ModelRegistry,
    private readonly contextManager: ContextManager,
    private readonly knowledge: KnowledgeService,
    private readonly skills: SkillRegistry,
    private readonly permissions: PermissionPolicy,
  ) {}

  async build(input: {
    session: Session;
    runId: string;
    request: SendMessageRequest;
    decision: PreflightDecision;
    signal: AbortSignal;
    tools: AgentTool[];
    promptOverride?: string;
    readOnly: boolean;
  }): Promise<AgentContext> {
    const userMessage = this.database.getMessage(input.request.messageId);
    const model = this.models.fromSnapshot(this.database.getRun(input.runId).model);
    const history = await this.contextManager.compact(
      input.session,
      this.database.listAgentMessages(input.session.id, userMessage.sequence),
      input.signal,
      false,
      model,
    );
    const memory = this.database.searchMemory(input.session.id, input.request.text, 5);
    const ownerId = this.database.sessionOwner(input.session.id);
    if (!ownerId) throw new Error("Session owner is missing");
    const profile = this.database.getAgentProfile(ownerId);
    const rollups = this.database.listMemoryRollups(input.session.id, 10);
    const knowledge = this.knowledge.search(input.request.text, 3, undefined, ownerId);
    const supportingContext = [
      profile.content ? `<agent_profile>\n${profile.content}\n</agent_profile>` : "",
      memory.length ? `<relevant_memory>\n${memory.join("\n")}\n</relevant_memory>` : "",
      rollups.length
        ? `<history_rollups>\n${rollups.map((item) => `[${item.fromSequence}-${item.toSequence}] ${item.summary}`).join("\n")}\n</history_rollups>`
        : "",
      knowledge.length
        ? `<relevant_knowledge>\n${knowledge.map((item) => `${item.filePath}\n${item.content}`).join("\n\n")}\n</relevant_knowledge>`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const plan =
      input.decision.route === "plan"
        ? `\n\nApproved execution plan:\n${input.decision.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`
        : "";
    const attachments = input.request.attachmentIds?.length
      ? `\n\nAttachments: ${input.request.attachmentIds.join(", ")}. Use attachment_read when needed.`
      : "";
    const images: ImageContent[] = [];
    for (const attachmentId of input.request.attachmentIds ?? []) {
      const attachment = this.database.getAttachment(attachmentId);
      if (!attachment?.mimeType.startsWith("image/")) continue;
      images.push({
        type: "image",
        data: await readFile(this.database.getAttachmentPath(attachmentId, input.session.id), "base64"),
        mimeType: attachment.mimeType,
      });
    }
    return {
      model,
      systemPrompt: `You are UmaAgent, a precise server-side assistant. Operate only inside the provided workspace. Use tools when needed and verify changes. Do not reveal private chain-of-thought.${this.skills.systemPrompt()}${history.summary ? `\n\n<conversation_summary>\n${history.summary.content}\n</conversation_summary>` : ""}${supportingContext ? `\n\n${supportingContext}` : ""}`,
      prompt: `${input.promptOverride ?? input.request.text}${plan}${attachments}`,
      images,
      tools: input.tools.filter(
        (tool) =>
          !input.readOnly || ["read", "attachment_read"].includes(this.permissions.classify(tool.name)),
      ),
      messages: history.messages,
    };
  }
}
