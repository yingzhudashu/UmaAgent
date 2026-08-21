import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SkillSummary } from "@uma-agent/protocol";
import YAML from "yaml";

export interface LoadedSkill extends SkillSummary {
  path: string;
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
  private readonly roots: string[];
  private watchers: FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(dirs: string[]) {
    this.roots = [...dirs];
  }

  addRoot(root: string): void {
    if (!this.roots.includes(root)) this.roots.push(root);
  }

  replaceRoots(roots: string[]): void {
    this.roots.splice(0, this.roots.length, ...new Set(roots));
  }

  async refresh(): Promise<SkillSummary[]> {
    const paths: string[] = [];
    for (const dir of this.roots) await scan(dir, paths);
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

  startWatching(onRefresh: () => void): void {
    this.stopWatching();
    for (const root of this.roots) {
      try {
        const watcher = watch(root, { recursive: true }, () => {
          if (this.refreshTimer) clearTimeout(this.refreshTimer);
          this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh()
              .then(onRefresh)
              .catch(() => {});
          }, 250);
        });
        this.watchers.push(watcher);
      } catch {
        // Missing optional roots are discovered by explicit refresh after installation.
      }
    }
  }

  stopWatching(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  list(): SkillSummary[] {
    return [...this.skills.values()]
      .map(({ content: _content, path: _path, ...summary }) => summary)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  read(name: string): string {
    const skill = this.skills.get(name);
    if (!skill || !skill.enabled) throw new Error(`Skill is unavailable: ${name}`);
    return skill.content;
  }

  systemPrompt(): string {
    const enabled = [...this.skills.values()].filter((skill) => skill.enabled);
    if (!enabled.length) return "";
    return `\n\n<available_skills>\n${enabled.map((skill) => `<skill><name>${skill.name}</name><description>${skill.description}</description></skill>`).join("\n")}\n</available_skills>\nUse skill_read to load a matching skill before following it.`;
  }
}
