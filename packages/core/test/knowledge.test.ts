import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingService } from "../src/embedding.js";
import { KnowledgeService } from "../src/knowledge.js";
import { testDatabase } from "./test-database.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uma-knowledge-"));
  temporary.push(root);
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const database = testDatabase(state);
  const knowledge = new KnowledgeService(database, [workspace], state);
  return { root, state, workspace, database, knowledge };
}

describe("KnowledgeService", () => {
  it("indexes files and directories with chunking, filtering, search and deletion", async () => {
    const { workspace, database, knowledge } = await fixture();
    await writeFile(join(workspace, "single.md"), `alpha ${"x".repeat(4_000)} omega`);
    const single = await knowledge.index("single", join(workspace, "single.md"));
    expect(single.status).toBe("indexed");
    expect(knowledge.search("alpha")[0]?.filePath).toContain("single.md");
    expect((await knowledge.searchSemantic("alpha"))[0]?.filePath).toContain("single.md");
    expect(await knowledge.searchSemantic(" ")).toEqual([]);

    const directory = join(workspace, "docs");
    await mkdir(join(directory, "nested"), { recursive: true });
    await mkdir(join(directory, ".hidden"));
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "nested", "guide.txt"), "directory needle");
    await writeFile(join(directory, "ignored.bin"), "directory needle");
    await writeFile(join(directory, ".hidden", "ignored.md"), "directory needle");
    await writeFile(join(directory, "node_modules", "ignored.md"), "directory needle");
    const indexed = await knowledge.index("directory", directory);
    expect(indexed.status).toBe("indexed");
    expect(knowledge.list()).toHaveLength(2);
    expect(knowledge.search("directory needle")).toEqual([
      expect.objectContaining({ filePath: join("nested", "guide.txt") }),
    ]);
    knowledge.delete(indexed.id);
    expect(knowledge.list()).toHaveLength(1);
    database.close();
  });

  it("queues ingestion and records a failed unsupported filesystem source", async () => {
    const { workspace, database, knowledge } = await fixture();
    const fifo = join(workspace, "unsupported.pdf");
    await writeFile(fifo, "not a real PDF");
    const queued = await knowledge.enqueue("broken document", fifo);
    expect(queued.status).toBe("queued");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (knowledge.list().find((item) => item.id === queued.id)?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(knowledge.list().find((item) => item.id === queued.id)).toMatchObject({
      status: "failed",
    });
    database.close();
  });

  it("rejects sources outside configured roots", async () => {
    const { root, database, knowledge } = await fixture();
    const outside = join(root, "outside.txt");
    await writeFile(outside, "secret");
    await expect(knowledge.index("outside", outside)).rejects.toThrow("outside configured");
    database.close();
  });

  it("surfaces embedding failures instead of silently returning keyword-only results", async () => {
    const { workspace, state, database } = await fixture();
    await writeFile(join(workspace, "fallback.md"), "embedding outage keyword");
    // 保留真实服务接口与 hash，只替换供应商 I/O，避免部分假对象遗漏合同。
    const embedding = new EmbeddingService();
    vi.spyOn(embedding, "enabled", "get").mockReturnValue(true);
    vi.spyOn(embedding, "embedBatch").mockImplementation(async (texts) => texts.map(() => [1, 0]));
    vi.spyOn(embedding, "embed").mockRejectedValue(new Error("HTTP 401"));
    const knowledge = new KnowledgeService(database, [workspace], state, embedding);
    try {
      await knowledge.index("fallback", join(workspace, "fallback.md"));
      await expect(knowledge.searchSemantic("embedding outage")).rejects.toThrow("HTTP 401");
      expect(embedding.embed).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });
});
