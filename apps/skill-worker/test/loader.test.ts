import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashDirectory, loadApprovedSkills } from "../src/loader.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("Skill Worker loader", () => {
  it("loads only a package whose calculated hash is explicitly approved", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-skill-worker-"));
    temporary.push(root);
    const directory = join(root, "demo");
    await mkdir(directory);
    await writeFile(join(directory, "tool.mjs"), "export const run = async input => ({ input });", "utf8");
    const contentHash = await hashDirectory(directory);
    await writeFile(
      join(directory, "skill-worker.json"),
      JSON.stringify({
        name: "demo",
        contentHash,
        entry: "tool.mjs",
        tools: [{ name: "run", description: "Run demo", export: "run" }],
      }),
      "utf8",
    );
    const loaded = await loadApprovedSkills(root, new Set([contentHash]));
    expect(loaded[0]?.manifest.name).toBe("demo");
    await expect(
      (loaded[0]?.module.run as (input: unknown) => Promise<unknown>)({ ok: true }),
    ).resolves.toEqual({
      input: { ok: true },
    });
    await expect(loadApprovedSkills(root, new Set(["different"]))).rejects.toThrow("not approved");
  });

  it("rejects symlinks before loading executable code", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-skill-worker-link-"));
    temporary.push(root);
    const directory = join(root, "demo");
    await mkdir(directory);
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "tool.mjs"), "export const run = () => 1", "utf8");
    await symlink(outside, join(directory, "linked"), "junction");
    await expect(hashDirectory(directory)).rejects.toThrow("cannot contain symlinks");
  });
});
