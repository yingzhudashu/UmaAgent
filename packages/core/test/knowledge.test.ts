import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UmaDatabase } from "../src/database.js";
import { KnowledgeService } from "../src/knowledge.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uma-knowledge-"));
  temporary.push(root);
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const database = new UmaDatabase(state);
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
});
