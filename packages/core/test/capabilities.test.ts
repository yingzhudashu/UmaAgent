import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeService } from "../src/knowledge.js";
import { PermissionPolicy } from "../src/permissions.js";
import { SkillRegistry } from "../src/skills.js";
import { createBuiltinTools } from "../src/tools.js";
import { WorkspacePolicy } from "../src/workspace.js";
import { testDatabase } from "./test-database.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("session capabilities", () => {
  it("applies tool isolation by interaction mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-capabilities-"));
    temporary.push(root);
    const db = testDatabase(join(root, "state"));
    const workspacePolicy = new WorkspacePolicy([root]);
    await workspacePolicy.initialize();
    const skills = new SkillRegistry([]);
    const knowledge = new KnowledgeService(db, [root], join(root, "state"));
    const session = db.createSession({
      title: "workspace",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const tools = (sessionInput: typeof session) =>
      createBuiltinTools({
        session: sessionInput,
        database: db,
        knowledge,
        skills,
        workspacePolicy,
        toolTimeoutMs: 1_000,
        memoryWrite: (scope, content) =>
          db.addMemoryFact({
            sessionId: sessionInput.id,
            scope,
            key: `explicit.${crypto.randomUUID()}`,
            value: content,
            category: "explicit",
            confidence: 1,
            status: "active",
          }),
      });
    const sessionTools = tools(session);
    const toolNames = sessionTools.map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["memory_search", "knowledge_search", "attachment_read"]),
    );
    const policy = new PermissionPolicy();
    expect(policy.decide("ask", "shell").allowed).toBe(false);
    expect(policy.decide("plan", "write").allowed).toBe(false);
    expect(policy.decide("agent", "memory_write").requiresApproval).toBe(true);
    const utf16Path = join(root, "utf16.txt");
    await writeFile(utf16Path, Buffer.from("\ufeffencoded attachment", "utf16le"));
    const attachment = db.addAttachment({
      sessionId: session.id,
      name: "utf16.txt",
      mimeType: "text/plain",
      size: 38,
      storagePath: utf16Path,
    });
    const attachmentRead = sessionTools.find((tool) => tool.name === "attachment_read");
    const attachmentResult = await attachmentRead?.execute(
      "read-attachment",
      { attachmentId: attachment.id },
      new AbortController().signal,
    );
    expect(JSON.stringify(attachmentResult)).toContain("encoded attachment");
    db.close();
  });

  it("exposes only validated skill metadata and reads enabled instructions by name", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-skill-"));
    temporary.push(root);
    const skillDir = join(root, "daily-helper");
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: daily-helper\ndescription: Helps with daily work.\n---\nFollow the documented steps.",
      "utf8",
    );
    const skills = new SkillRegistry([root]);
    const summaries = await skills.refresh();
    expect(summaries).toEqual([
      { name: "daily-helper", description: "Helps with daily work.", enabled: true, diagnostics: [] },
    ]);
    expect(skills.read("daily-helper")).toContain("Follow the documented steps");
    expect(JSON.stringify(summaries)).not.toContain(root);
  });

  it("rejects knowledge sources outside workspaces and managed uploads", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-knowledge-root-"));
    const outside = await mkdtemp(join(tmpdir(), "uma-knowledge-outside-"));
    temporary.push(root, outside);
    const state = join(root, "state");
    const db = testDatabase(state);
    const service = new KnowledgeService(db, [join(root, "workspace")], state);
    await mkdir(join(root, "workspace"));
    const path = join(outside, "private.txt");
    await writeFile(path, "not allowed", "utf8");
    await expect(service.index("private", path)).rejects.toThrow("outside configured workspace");
    db.close();
  });
});
