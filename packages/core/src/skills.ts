import { accessSync, constants, type Dirent, existsSync, type FSWatcher, watch } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SkillSummary } from "@uma-agent/protocol";
import YAML from "yaml";
import { BUILTIN_SKILLS } from "./builtin-skills.js";

export interface SkillMetadata {
  bins: string[];
  env: string[];
  os: string[];
  always: boolean;
  userInvocable: boolean;
  disableModelInvocation: boolean;
}

export interface LoadedSkill extends SkillSummary {
  path: string;
  content: string;
  metadata: SkillMetadata;
}

type ParsedSkill = { metadata: Record<string, unknown>; content: string; diagnostics: string[] };

function asStringList(value: unknown): string[] {
  if (typeof value === "string")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return fallback;
}

function parseSkill(raw: string): ParsedSkill {
  if (!raw.startsWith("---\n"))
    return { metadata: {}, content: raw, diagnostics: ["SKILL.md frontmatter is required"] };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { metadata: {}, content: raw, diagnostics: ["SKILL.md frontmatter is incomplete"] };
  try {
    const parsed = YAML.parse(raw.slice(4, end));
    return {
      metadata:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      content: raw.slice(end + 5),
      diagnostics:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? []
          : ["SKILL.md frontmatter must be an object"],
    };
  } catch (error) {
    return {
      metadata: {},
      content: raw.slice(end + 5),
      diagnostics: [
        `SKILL.md frontmatter is invalid: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function platformName(): string {
  return process.platform === "win32" ? "windows" : process.platform;
}

function commandAvailable(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  return pathValue.split(process.platform === "win32" ? ";" : ":").some((directory) =>
    extensions.some((extension) => {
      const candidate = join(directory, `${command}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

function skillMetadata(metadata: Record<string, unknown>): SkillMetadata {
  const raw =
    metadata.metadata && typeof metadata.metadata === "object" && !Array.isArray(metadata.metadata)
      ? (metadata.metadata as Record<string, unknown>)
      : metadata;
  return {
    bins: asStringList(raw.bins),
    env: asStringList(raw.env),
    os: asStringList(raw.os),
    always: asBoolean(raw.always, false),
    userInvocable: asBoolean(raw.user_invocable ?? raw.userInvocable, true),
    disableModelInvocation: asBoolean(raw.disable_model_invocation ?? raw.disableModelInvocation, false),
  };
}

function skillScope(metadata: Record<string, unknown>): string {
  const value = typeof metadata.scope === "string" ? metadata.scope.trim() : "global";
  return value === "global" || /^session:[A-Za-z0-9_-]+$/.test(value) ? value : "invalid";
}

function isVisible(scope: string, sessionId?: string): boolean {
  return scope === "global" || (sessionId !== undefined && scope === `session:${sessionId}`);
}

export class SkillRegistry {
  private skills = new Map<string, LoadedSkill>();
  private readonly roots: string[];
  private readonly builtins: Map<string, LoadedSkill>;
  private watchers: FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(dirs: string[], options: { includeBuiltins?: boolean } = {}) {
    this.roots = [...dirs];
    this.builtins = new Map(
      options.includeBuiltins === true
        ? BUILTIN_SKILLS.map((skill) => [skill.name, skill as unknown as LoadedSkill])
        : [],
    );
    this.skills = new Map(this.builtins);
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
    const next = new Map(this.builtins);
    for (const path of paths) {
      const diagnostics: string[] = [];
      const raw = await readFile(path, "utf8");
      const parsed = parseSkill(raw);
      diagnostics.push(...parsed.diagnostics);
      const metadata = skillMetadata(parsed.metadata);
      const name = typeof parsed.metadata.name === "string" ? parsed.metadata.name : basename(dirname(path));
      const description =
        typeof parsed.metadata.description === "string" ? parsed.metadata.description.trim() : "";
      const keywords = asStringList(parsed.metadata.keywords);
      const scope = skillScope(parsed.metadata);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
        diagnostics.push("Invalid skill name");
      if (!description || description.length > 1024)
        diagnostics.push("Description is required and must be at most 1024 characters");
      if (scope === "invalid") diagnostics.push("Skill scope must be global or session:<id>");
      if (!metadata.always) {
        for (const required of metadata.env)
          if (!process.env[required]) diagnostics.push(`Missing environment variable: ${required}`);
        for (const required of metadata.bins)
          if (!commandAvailable(required)) diagnostics.push(`Missing system command: ${required}`);
        if (metadata.os.length && !metadata.os.some((item) => item.toLowerCase() === platformName()))
          diagnostics.push(`Unsupported operating system: ${platformName()}`);
      }
      const canonical = await realpath(path);
      next.set(name, {
        name,
        description,
        enabled: diagnostics.length === 0,
        diagnostics,
        keywords,
        scope,
        userInvocable: metadata.userInvocable,
        modelInvocable: !metadata.disableModelInvocation,
        path: canonical,
        content: parsed.content,
        metadata,
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
        // 缺失的可选目录由显式 refresh 发现，不能阻止 Core 启动。
      }
    }
  }

  stopWatching(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  list(sessionId?: string): SkillSummary[] {
    return [...this.skills.values()]
      .filter((skill) => isVisible(skill.scope ?? "global", sessionId))
      .map(({ content: _content, path: _path, metadata: _metadata, ...summary }) => summary)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  read(name: string, sessionId?: string): string {
    const skill = this.skills.get(name);
    if (
      !skill ||
      !skill.enabled ||
      !isVisible(skill.scope ?? "global", sessionId) ||
      skill.modelInvocable === false
    )
      throw new Error(`Skill is unavailable: ${name}`);
    return skill.content;
  }

  systemPrompt(sessionId?: string): string {
    const enabled = [...this.skills.values()].filter(
      (skill) =>
        skill.enabled && skill.modelInvocable !== false && isVisible(skill.scope ?? "global", sessionId),
    );
    if (!enabled.length) return "";
    return `\n\n<available_skills>\n${enabled
      .map(
        (skill) =>
          `<skill><name>${skill.name}</name><description>${skill.description}</description>${skill.keywords?.length ? `<keywords>${skill.keywords.join(", ")}</keywords>` : ""}</skill>`,
      )
      .join("\n")}\n</available_skills>\nUse skill_read to load a matching skill before following it.`;
  }
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
