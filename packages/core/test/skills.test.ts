import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillRegistry } from "../src/skills.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("SkillRegistry", () => {
  it("loads the MiniAgent-inspired built-in skill baseline", async () => {
    const registry = new SkillRegistry([], { includeBuiltins: true });
    await registry.refresh();
    expect(registry.list().map((item) => item.name)).toEqual([
      "builtin-stackexchange",
      "builtin-web",
      "skill-creator",
      "skill-vetter",
    ]);
    expect(registry.systemPrompt()).toContain("<name>builtin-web</name>");
    expect(registry.read("builtin-web")).toContain("Browser MCP");
  });

  it("ignores unavailable and excluded directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-skills-empty-"));
    temporary.push(root);
    await mkdir(join(root, ".hidden"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, ".hidden", "SKILL.md"), "hidden", "utf8");
    await writeFile(join(root, "node_modules", "SKILL.md"), "dependency", "utf8");
    const registry = new SkillRegistry([join(root, "missing"), root]);
    await expect(registry.refresh()).resolves.toEqual([]);
    expect(registry.systemPrompt()).toBe("");
    expect(() => registry.read("missing")).toThrow("unavailable");
  });

  it("reports invalid metadata and stops scanning below a skill root", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-skills-invalid-"));
    temporary.push(root);
    const invalid = join(root, "Invalid_Name");
    await mkdir(join(invalid, "nested"), { recursive: true });
    await writeFile(join(invalid, "SKILL.md"), "instructions without metadata", "utf8");
    await writeFile(
      join(invalid, "nested", "SKILL.md"),
      "---\nname: nested\ndescription: should not be found\n---\nNested",
      "utf8",
    );
    const registry = new SkillRegistry([root]);
    const summaries = await registry.refresh();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ name: "Invalid_Name", enabled: false });
    expect(summaries[0]?.diagnostics).toEqual(
      expect.arrayContaining(["Invalid skill name", expect.stringContaining("Description")]),
    );
    expect(() => registry.read("Invalid_Name")).toThrow("unavailable");
  });

  it("handles incomplete and scalar front matter without exposing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-skills-frontmatter-"));
    temporary.push(root);
    const incomplete = join(root, "incomplete");
    const scalar = join(root, "scalar");
    await mkdir(incomplete);
    await mkdir(scalar);
    await writeFile(join(incomplete, "SKILL.md"), "---\nname: ignored", "utf8");
    await writeFile(join(scalar, "SKILL.md"), "---\nplain scalar\n---\nBody", "utf8");
    const registry = new SkillRegistry([root]);
    const summaries = await registry.refresh();
    expect(summaries.map((item) => item.name)).toEqual(["incomplete", "scalar"]);
    expect(summaries.every((item) => !item.enabled)).toBe(true);
  });

  it("sorts enabled skills and emits a metadata-only system prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-skills-prompt-"));
    temporary.push(root);
    for (const [name, description] of [
      ["zeta", "Last skill"],
      ["alpha", "First skill"],
    ]) {
      await mkdir(join(root, name));
      await writeFile(
        join(root, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\nSecret body`,
        "utf8",
      );
    }
    const registry = new SkillRegistry([root]);
    expect((await registry.refresh()).map((item) => item.name)).toEqual(["alpha", "zeta"]);
    expect(registry.systemPrompt()).toContain("<name>alpha</name>");
    expect(registry.systemPrompt()).not.toContain("Secret body");
  });

  it("applies MiniAgent metadata gates, model visibility, and session scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-skills-gates-"));
    temporary.push(root);
    await mkdir(join(root, "gated"));
    await writeFile(
      join(root, "gated", "SKILL.md"),
      "---\nname: gated\ndescription: Gated\nkeywords: [test, gate]\nmetadata:\n  env: [UMA_SKILL_TEST_MISSING]\n---\nUnavailable",
      "utf8",
    );
    await mkdir(join(root, "private"));
    await writeFile(
      join(root, "private", "SKILL.md"),
      "---\nname: private\ndescription: Private\nscope: session:session-a\nmetadata:\n  disable_model_invocation: true\n---\nPrivate body",
      "utf8",
    );
    const registry = new SkillRegistry([root]);
    const summaries = await registry.refresh();
    expect(summaries.find((item) => item.name === "gated")).toMatchObject({
      enabled: false,
      keywords: ["test", "gate"],
    });
    expect(summaries.find((item) => item.name === "gated")?.diagnostics).toContain(
      "Missing environment variable: UMA_SKILL_TEST_MISSING",
    );
    expect(registry.list("session-a").find((item) => item.name === "private")).toBeDefined();
    expect(registry.list("session-b").find((item) => item.name === "private")).toBeUndefined();
    expect(registry.systemPrompt("session-a")).not.toContain("<name>private</name>");
    expect(() => registry.read("private", "session-a")).toThrow("unavailable");
  });
});
