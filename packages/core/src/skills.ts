import type { Dirent } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SkillSummary } from "@uma-agent/protocol";
import YAML from "yaml";

export interface LoadedSkill extends SkillSummary {
  content: string;
}

function parseSkill(raw: string): { metadata: Record<string, unknown>; content: string } {
  if (!raw.startsWith("---\n")) return { metadata: {}, content: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { metadata: {}, content: raw };
  const parsed = YAML.parse(raw.slice(4, end));
  return {
    metadata: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
    content: raw.slice(end + 5),
  };
}

async function scan(root: string, output: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const skill = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
  if (skill) {
    output.push(join(root, skill.name));
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      await scan(join(root, entry.name), output);
  }
}

export class SkillRegistry {
  private skills = new Map<string, LoadedSkill>();

  constructor(private readonly dirs: string[]) {}

  async refresh(): Promise<SkillSummary[]> {
    const paths: string[] = [];
    for (const dir of this.dirs) await scan(dir, paths);
    const next = new Map<string, LoadedSkill>();
    for (const path of paths) {
      const diagnostics: string[] = [];
      const raw = await readFile(path, "utf8");
      const { metadata, content } = parseSkill(raw);
      const name = typeof metadata.name === "string" ? metadata.name : basename(dirname(path));
      const description = typeof metadata.description === "string" ? metadata.description : "";
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
        diagnostics.push("Invalid skill name");
      if (!description || description.length > 1024)
        diagnostics.push("Description is required and must be at most 1024 characters");
      const canonical = await realpath(path);
      next.set(name, {
        name,
        description,
        path: canonical,
        enabled: diagnostics.length === 0,
        diagnostics,
        content,
      });
    }
    this.skills = next;
    return this.list();
  }

  list(): SkillSummary[] {
    return [...this.skills.values()]
      .map(({ content: _content, ...summary }) => summary)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  systemPrompt(): string {
    const enabled = [...this.skills.values()].filter((skill) => skill.enabled);
    if (!enabled.length) return "";
    return `\n\n<available_skills>\n${enabled.map((skill) => `<skill><name>${skill.name}</name><description>${skill.description}</description><location>${skill.path}</location></skill>`).join("\n")}\n</available_skills>\nLoad a matching SKILL.md with the read tool before following it.`;
  }
}
